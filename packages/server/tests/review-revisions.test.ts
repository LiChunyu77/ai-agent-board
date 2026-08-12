import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { Router } from 'express';
import type { Pool } from 'pg';
import { CopilotProvider } from '@codewithdan/agent-sdk-core';
import { initPostgresDatabase, migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';
import { createRevisionsRouter } from '../src/routes/revisions.js';
import { createGitRouter } from '../src/routes/git.js';
import type { Task } from '../src/types.js';
import {
  AgentManager,
  buildAgentExecutionPrompt,
  buildAgentSystemPrompt,
  evaluateRevisionToolUse,
  inspectRevisionCompletion,
  isRevisionCommitOnRemote,
  providerSupportsRevisionToolGuard,
  resolveRevisionPushIntent,
  resolveRevisionPushPermission,
  type AgentRunOptions,
} from '../src/services/agent-manager.js';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: (err?: unknown) => void) => void }>;
  };
}

async function invokeRoute(
  router: Router,
  method: 'get' | 'post',
  path: string,
  request: { params: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const layer = (router as unknown as { stack: RouteLayer[] }).stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method],
  );
  assert.ok(layer?.route, `route ${method.toUpperCase()} ${path} is registered`);
  return new Promise((resolve, reject) => {
    let status = 200;
    const response = {
      status(code: number) { status = code; return response; },
      json(body: unknown) { resolve({ status, body }); return response; },
    };
    layer.route!.stack[0].handle(request, response, (err?: unknown) => err ? reject(err) : undefined);
  });
}

function makeRepo() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateSqliteDatabase(db);
  return { db, repo: new SqliteTaskRepository(db) };
}

function reviewTask(id = 'task-1'): Task {
  return {
    id,
    projectId: 'default',
    title: 'Polish review flow',
    description: 'Implement the requested behavior.',
    priority: 'high',
    columnId: 'review',
    agentStatus: 'complete',
    agentType: 'codex',
    createdAt: 100,
    completedAt: 200,
    summary: 'Initial execution summary',
    repoPath: path.join(os.tmpdir(), 'agentboard-review-test'),
    branchName: 'task/review-flow',
    prUrl: 'https://example.test/pull/1',
  };
}

test('SQLite migration preserves task data and creates revision history incrementally', async () => {
  const { db, repo } = makeRepo();
  try {
    await repo.create(reviewTask());
    const first = await repo.beginRevision({ id: 'revision-1', taskId: 'task-1', feedback: 'Fix spacing', createdAt: 300 });
    assert.ok(first);
    assert.equal(first.revision.revisionNumber, 1);
    assert.equal(first.revision.previousSummary, 'Initial execution summary');
    assert.equal(first.revision.pushStatus, 'local');
    assert.equal(first.task.columnId, 'in-progress');
    assert.equal(first.task.agentStatus, 'planning');
    assert.equal(first.task.completedAt, undefined);
    assert.equal(first.task.runRequestedAt, 300);
    assert.equal(first.task.runClaimedAt, undefined);
    assert.equal(first.task.prUrl, 'https://example.test/pull/1');

    assert.equal(await repo.beginRevision({ id: 'duplicate', taskId: 'task-1', feedback: 'Race', createdAt: 301 }), undefined);
    await repo.updateRevision('revision-1', {
      status: 'complete',
      startedAt: 310,
      completedAt: 400,
      agentSummary: 'Spacing fixed',
      commitSha: 'abc123',
    });
    await repo.update('task-1', { columnId: 'review', agentStatus: 'complete', summary: 'Spacing fixed' });
    const second = await repo.beginRevision({ id: 'revision-2', taskId: 'task-1', feedback: 'Adjust color', createdAt: 500 });
    assert.equal(second?.revision.revisionNumber, 2);
    assert.equal(second?.revision.previousSummary, 'Spacing fixed');

    migrateSqliteDatabase(db);
    const revisions = await repo.getRevisionsByTaskId('task-1');
    assert.deepEqual(revisions.map((revision) => revision.id), ['revision-1', 'revision-2']);
    assert.equal(revisions[0].commitSha, 'abc123');
    assert.equal((await repo.getById('task-1'))?.prUrl, 'https://example.test/pull/1');

    await repo.delete('task-1');
    assert.deepEqual(await repo.getRevisionsByTaskId('task-1'), []);
  } finally {
    db.close();
  }
});

test('PostgreSQL migration declares the same PR and revision schema', async () => {
  const statements: string[] = [];
  const fakePool = {
    async query(query: string) {
      statements.push(query);
      return { rows: [] };
    },
  } as unknown as Pool;

  await initPostgresDatabase(fakePool);
  const sql = statements.join('\n');
  assert.match(sql, /ALTER TABLE tasks ADD COLUMN pr_url TEXT|pr_url\s+TEXT/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS task_revisions/);
  assert.match(sql, /push_status/);
  assert.match(sql, /pushed_at/);
  assert.match(sql, /released_by_revision_id/);
  assert.match(sql, /UNIQUE \(task_id, revision_number\)/);
  assert.match(sql, /REFERENCES tasks\(id\) ON DELETE CASCADE/);
});

test('PostgreSQL beginRevision uses one transaction and returns the aligned contract', async () => {
  const queries: string[] = [];
  const taskRow = {
    id: 'task-1', project_id: 'default', title: 'Review', description: '', priority: 'medium',
    column_id: 'review', agent_status: 'complete', created_at: '100', started_at: '110', completed_at: '200',
    repo_path: null, branch_name: null, base_branch: null, use_worktree: null, worktree_path: null,
    agent_type: 'codex', archived: false, group_id: null, group_order: null, summary: 'Prior result',
    external_source: null, external_key: null, provenance: null, run_requested_at: null, run_claimed_at: null,
    timeout_minutes: null, pr_url: 'https://example.test/pull/1',
  };
  const client = {
    async query(query: string) {
      queries.push(query);
      if (query.includes('SELECT * FROM tasks')) return { rows: [taskRow] };
      if (query.includes('COALESCE(MAX(revision_number)')) return { rows: [{ revision_number: 1 }] };
      if (query.includes('INSERT INTO task_revisions')) return { rows: [{
        id: 'revision-1', task_id: 'task-1', revision_number: 1, feedback: 'Fix it', status: 'pending',
        created_at: '300', started_at: null, completed_at: null, previous_summary: 'Prior result',
        agent_summary: null, commit_sha: null,
      }] };
      if (query.includes('UPDATE tasks SET')) return { rows: [{
        ...taskRow, column_id: 'in-progress', agent_status: 'planning', started_at: '300',
        completed_at: null, run_requested_at: '300',
      }] };
      return { rows: [] };
    },
    release() {},
  };
  const fakePool = { connect: async () => client } as unknown as Pool;
  const repo = new PostgresTaskRepository(fakePool);
  const result = await repo.beginRevision({ id: 'revision-1', taskId: 'task-1', feedback: 'Fix it', createdAt: 300 });

  assert.equal(result?.revision.previousSummary, 'Prior result');
  assert.equal(result?.task.runRequestedAt, 300);
  assert.equal(result?.task.prUrl, 'https://example.test/pull/1');
  assert.equal(queries[0], 'BEGIN');
  assert.equal(queries.at(-1), 'COMMIT');
  assert.match(queries.join('\n'), /FOR UPDATE/);
  assert.match(queries.join('\n'), /run_requested_at = \$1, run_claimed_at = NULL/);
});

test('PostgreSQL finalization atomically releases earlier held revisions', async () => {
  const queries: string[] = [];
  const revisionRow = {
    id: 'revision-3', task_id: 'task-1', revision_number: 3, feedback: '可以 push，包括之前修改',
    status: 'in-progress', created_at: '300', started_at: '310', completed_at: null,
    previous_summary: null, agent_summary: null, commit_sha: null, push_status: 'local',
    pushed_at: null, released_by_revision_id: null,
  };
  const client = {
    async query(query: string) {
      queries.push(query);
      if (query.includes('SELECT * FROM task_revisions')) return { rows: [revisionRow] };
      if (query.includes('WHERE id = $7')) return { rows: [{
        ...revisionRow,
        status: 'complete',
        completed_at: '400',
        commit_sha: 'fc507de',
        push_status: 'pushed',
        pushed_at: '400',
      }] };
      return { rows: [] };
    },
    release() {},
  };
  const repo = new PostgresTaskRepository({ connect: async () => client } as unknown as Pool);
  const finalized = await repo.finalizeRevision('revision-3', {
    status: 'complete',
    completedAt: 400,
    agentSummary: 'Done',
    commitSha: 'fc507de',
    pushStatus: 'pushed',
    pushedAt: 400,
    releaseHeldRevisions: true,
  });

  assert.equal(finalized?.pushStatus, 'pushed');
  assert.match(queries.join('\n'), /push_status = 'released'/);
  assert.match(queries.join('\n'), /released_by_revision_id = \$2/);
  assert.equal(queries[0], 'BEGIN');
  assert.equal(queries.at(-1), 'COMMIT');
});

test('request-changes API validates state and returns the atomic task/revision shape', async () => {
  const { db, repo } = makeRepo();
  try {
    await repo.create(reviewTask());
    const starts: string[] = [];
    const manager = {
      isRunning: () => false,
      resetEvents: () => {},
      startAgent: (task: Task, _onStatus?: unknown, _onWorktree?: unknown, _options?: unknown) => { starts.push(task.id); },
    } as unknown as AgentManager;
    const router = createRevisionsRouter(repo, manager);
    const invalid = await invokeRoute(router, 'post', '/:id/request-changes', {
      params: { id: 'task-1' },
      body: { feedback: '   ' },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await repo.getRevisionsByTaskId('task-1'), []);

    const response = await invokeRoute(router, 'post', '/:id/request-changes', {
      params: { id: 'task-1' },
      body: { feedback: '  Please fix the empty state.  ' },
    });
    assert.equal(response.status, 201);
    const body = response.body as { task: Task; revision: { feedback: string; revisionNumber: number } };
    assert.equal(body.task.columnId, 'in-progress');
    assert.equal(body.task.agentStatus, 'planning');
    assert.equal(body.revision.feedback, 'Please fix the empty state.');
    assert.equal(body.revision.revisionNumber, 1);
    assert.deepEqual(starts, ['task-1']);

    const conflict = await invokeRoute(router, 'post', '/:id/request-changes', {
      params: { id: 'task-1' },
      body: { feedback: 'Second simultaneous request' },
    });
    assert.equal(conflict.status, 409);

    const history = await invokeRoute(router, 'get', '/:id/revisions', { params: { id: 'task-1' } });
    assert.equal(history.status, 200);
    assert.equal((history.body as unknown[]).length, 1);
  } finally {
    db.close();
  }
});

test('completed no-push revision is durably finalized as held', async () => {
  const { db, repo } = makeRepo();
  try {
    await repo.create(reviewTask());
    let capturedOptions: AgentRunOptions | undefined;
    const manager = {
      isRunning: () => false,
      resetEvents: () => {},
      startAgent: (_task: Task, _onStatus?: unknown, _onWorktree?: unknown, options?: AgentRunOptions) => {
        capturedOptions = options;
      },
    } as unknown as AgentManager;
    const response = await invokeRoute(createRevisionsRouter(repo, manager), 'post', '/:id/request-changes', {
      params: { id: 'task-1' },
      body: { feedback: '完成修复，但不要 push。' },
    });
    assert.equal(response.status, 201);
    const onComplete = capturedOptions?.onComplete;
    assert.ok(onComplete);
    await onComplete({
      revisionId: (response.body as { revision: { id: string } }).revision.id,
      status: 'complete',
      agentSummary: 'Committed locally',
      commitSha: '2d67919',
      pushed: false,
    });

    const [revision] = await repo.getRevisionsByTaskId('task-1');
    assert.equal(revision.pushStatus, 'held');
    assert.equal(revision.commitSha, '2d67919');
    assert.equal(await repo.hasHeldRevisions('task-1'), true);
  } finally {
    db.close();
  }
});

test('completed ambiguous revision is durably held and cannot release an earlier hold', async () => {
  const { db, repo } = makeRepo();
  try {
    await repo.create(reviewTask());
    const earlier = await repo.beginRevision({
      id: 'earlier-held-revision',
      taskId: 'task-1',
      feedback: '不要推送。',
      createdAt: 250,
    });
    assert.ok(earlier);
    await repo.finalizeRevision(earlier.revision.id, {
      status: 'complete',
      completedAt: 275,
      agentSummary: 'Held locally',
      commitSha: 'abc1234',
      pushStatus: 'held',
      releaseHeldRevisions: false,
    });
    await repo.update('task-1', { columnId: 'review', agentStatus: 'complete' });

    let capturedOptions: AgentRunOptions | undefined;
    const manager = {
      isRunning: () => false,
      resetEvents: () => {},
      startAgent: (_task: Task, _onStatus?: unknown, _onWorktree?: unknown, options?: AgentRunOptions) => {
        capturedOptions = options;
      },
    } as unknown as AgentManager;
    const response = await invokeRoute(createRevisionsRouter(repo, manager), 'post', '/:id/request-changes', {
      params: { id: 'task-1' },
      body: { feedback: '继续修复空状态。' },
    });
    assert.equal(response.status, 201);
    assert.equal(capturedOptions?.revision?.hasHeldRevisions, true);
    assert.ok(capturedOptions?.onComplete);
    await capturedOptions.onComplete({
      revisionId: (response.body as { revision: { id: string } }).revision.id,
      status: 'complete',
      agentSummary: 'Second local revision',
      commitSha: 'def5678',
      pushed: false,
    });

    const revisions = await repo.getRevisionsByTaskId('task-1');
    assert.deepEqual(revisions.map((revision) => revision.pushStatus), ['held', 'held']);
    assert.equal(revisions[0].releasedByRevisionId, null);
    assert.equal(await repo.hasHeldRevisions('task-1'), true);
  } finally {
    db.close();
  }
});

test('completion metadata cannot mark or release an unauthorized revision as pushed', async () => {
  const { db, repo } = makeRepo();
  try {
    await repo.create(reviewTask());
    const earlier = await repo.beginRevision({
      id: 'metadata-held-revision',
      taskId: 'task-1',
      feedback: '不要推送。',
      createdAt: 200,
    });
    assert.ok(earlier);
    await repo.finalizeRevision(earlier.revision.id, {
      status: 'complete', completedAt: 225, agentSummary: 'Held', commitSha: 'abc1234',
      pushStatus: 'held', releaseHeldRevisions: false,
    });
    await repo.update('task-1', { columnId: 'review', agentStatus: 'complete' });

    let capturedOptions: AgentRunOptions | undefined;
    const manager = {
      isRunning: () => false,
      resetEvents: () => {},
      startAgent: (_task: Task, _onStatus?: unknown, _onWorktree?: unknown, options?: AgentRunOptions) => {
        capturedOptions = options;
      },
    } as unknown as AgentManager;
    const response = await invokeRoute(createRevisionsRouter(repo, manager), 'post', '/:id/request-changes', {
      params: { id: 'task-1' },
      body: { feedback: '继续修复，但不要推送。' },
    });
    assert.equal(response.status, 201);
    assert.ok(capturedOptions?.onComplete);
    await capturedOptions.onComplete({
      status: 'complete', agentSummary: 'Local only', commitSha: 'def5678', pushed: true,
    });

    const revisions = await repo.getRevisionsByTaskId('task-1');
    assert.deepEqual(revisions.map((revision) => revision.pushStatus), ['held', 'held']);
    assert.equal(revisions[0].releasedByRevisionId, null);
  } finally {
    db.close();
  }
});

test('create-pr API persists the pull request URL on the task', async () => {
  const { db, repo } = makeRepo();
  try {
    await repo.create({ ...reviewTask(), prUrl: null });
    const manager = {
      createPR: () => ({ url: 'https://example.test/pull/42' }),
    } as unknown as AgentManager;
    const response = await invokeRoute(createGitRouter(repo, manager), 'post', '/:id/create-pr', {
      params: { id: 'task-1' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { url: 'https://example.test/pull/42' });
    assert.equal((await repo.getById('task-1'))?.prUrl, 'https://example.test/pull/42');
  } finally {
    db.close();
  }
});

test('revision push defaults to held even when an existing PR has no prior hold', () => {
  const task = reviewTask();
  const prompt = buildAgentExecutionPrompt(task, {
    revisionId: 'revision-1',
    feedback: 'Fix the CI failure',
    previousSummary: 'The first implementation added the feature.',
    prUrl: 'https://example.test/pull/1',
  });
  assert.match(prompt, /NEW revision execution round/);
  assert.match(prompt, /highest priority/);
  assert.match(prompt, /push permission is denied by default/i);
  assert.doesNotMatch(prompt, /git push origin task\/review-flow/);
  assert.match(prompt, /Never force-push/);
});

test('push hold A-C: held commit blocks defaults until explicit authorization releases it', async () => {
  const { db, repo } = makeRepo();
  try {
    await repo.create(reviewTask());

    const first = await repo.beginRevision({
      id: 'held-revision-1',
      taskId: 'task-1',
      feedback: '修复问题，但不要 push。',
      createdAt: 300,
    });
    assert.ok(first);
    await repo.finalizeRevision(first.revision.id, {
      status: 'complete',
      completedAt: 400,
      agentSummary: 'First local fix',
      commitSha: '2d67919',
      pushStatus: 'held',
      releaseHeldRevisions: false,
    });
    assert.equal(await repo.hasHeldRevisions('task-1'), true);
    assert.equal((await repo.getRevisionsByTaskId('task-1'))[0].pushStatus, 'held');

    await repo.update('task-1', { columnId: 'review', agentStatus: 'complete' });
    const second = await repo.beginRevision({
      id: 'held-revision-2',
      taskId: 'task-1',
      feedback: '继续修复空状态。',
      createdAt: 500,
    });
    assert.ok(second);
    const blockedPrompt = buildAgentExecutionPrompt(second.task, {
      revisionId: second.revision.id,
      feedback: second.revision.feedback,
      prUrl: second.task.prUrl ?? undefined,
      hasHeldRevisions: await repo.hasHeldRevisions('task-1'),
    });
    assert.match(blockedPrompt, /contains revisions whose push is still held/i);
    assert.doesNotMatch(blockedPrompt, /git push origin/);
    await repo.finalizeRevision(second.revision.id, {
      status: 'complete',
      completedAt: 600,
      agentSummary: 'Second local fix',
      commitSha: 'fc507de',
      pushStatus: 'held',
      releaseHeldRevisions: false,
    });
    assert.equal(await repo.hasHeldRevisions('task-1'), true);

    await repo.update('task-1', { columnId: 'review', agentStatus: 'complete' });
    const third = await repo.beginRevision({
      id: 'held-revision-3',
      taskId: 'task-1',
      feedback: '可以 push，包括之前修改。',
      createdAt: 700,
    });
    assert.ok(third);
    const releasePrompt = buildAgentExecutionPrompt(third.task, {
      revisionId: third.revision.id,
      feedback: third.revision.feedback,
      prUrl: third.task.prUrl ?? undefined,
      hasHeldRevisions: await repo.hasHeldRevisions('task-1'),
    });
    assert.match(releasePrompt, /explicitly authorizes releasing the existing push hold/i);
    assert.match(releasePrompt, /git push origin task\/review-flow/);
    await repo.finalizeRevision(third.revision.id, {
      status: 'complete',
      completedAt: 800,
      agentSummary: 'Released all changes',
      commitSha: 'abc7890',
      pushStatus: 'pushed',
      pushedAt: 800,
      releaseHeldRevisions: true,
    });

    const history = await repo.getRevisionsByTaskId('task-1');
    assert.deepEqual(history.map((revision) => revision.pushStatus), ['released', 'released', 'pushed']);
    assert.equal(history[0].pushedAt, 800);
    assert.equal(history[0].releasedByRevisionId, 'held-revision-3');
    assert.equal(await repo.hasHeldRevisions('task-1'), false);
  } finally {
    db.close();
  }
});

test('explicit push release intent requires high-confidence current feedback', () => {
  assert.equal(resolveRevisionPushIntent('可以 push，包括之前修改。'), 'authorize');
  assert.equal(resolveRevisionPushIntent('推送到现有 PR。'), 'authorize');
  assert.equal(resolveRevisionPushIntent('把之前的修改一起 push。'), 'authorize');
  assert.equal(resolveRevisionPushIntent('You can push all previous changes.'), 'authorize');
  assert.equal(resolveRevisionPushIntent('继续修复空状态。'), 'unspecified');
  assert.equal(resolveRevisionPushIntent('不可以 push。'), 'prohibit');
});

test('natural English, Chinese, and mixed-language push prohibitions deny push', () => {
  for (const feedback of [
    '不要推送。',
    '不推送。',
    '暂不推送。',
    '先不要推送。',
    '不要 push。',
    '这次不要提交到远程。',
    '先保留在本地。',
    'Do not push.',
    "Don't push.",
    'No push.',
    'Keep these changes local.',
    'Do not upload these changes to remote.',
    'Commit locally but do not push.',
  ]) {
    assert.equal(resolveRevisionPushIntent(feedback), 'prohibit', feedback);
    assert.equal(resolveRevisionPushPermission(reviewTask(), {
      revisionId: 'revision-natural-language',
      feedback,
      prUrl: 'https://example.test/pull/1',
    }).allowed, false, feedback);
  }
});

test('commit-local/no-push feedback allows commit while denying push', () => {
  for (const feedback of [
    'Commit locally but do not push.',
    '请在本地 commit，但不要推送。',
    '本地提交即可，不要提交到远程。',
  ]) {
    const prompt = buildAgentExecutionPrompt(reviewTask(), {
      revisionId: 'revision-local-commit',
      feedback,
      prUrl: 'https://example.test/pull/1',
    });
    assert.match(prompt, /create a concise commit/i, feedback);
    assert.match(prompt, /explicitly prohibits push/i, feedback);
    assert.doesNotMatch(prompt, /Do not create a commit/i, feedback);
  }
});

test('ordinary push permission is explicit, branch-scoped, and force-push is never authorized', () => {
  const authorized = resolveRevisionPushPermission(reviewTask(), {
    revisionId: 'revision-authorized-push',
    feedback: 'Please push these changes to the existing PR.',
    prUrl: 'https://example.test/pull/1',
  });
  assert.equal(authorized.allowed, true);
  assert.equal(
    evaluateRevisionToolUse({ toolName: 'bash', toolArgs: { command: 'git push origin task/review-flow' } }, authorized).permissionDecision,
    'allow',
  );
  assert.equal(
    evaluateRevisionToolUse({ toolName: 'bash', toolArgs: { command: 'git push origin another-branch' } }, authorized).permissionDecision,
    'deny',
  );
  for (const command of [
    'git push --force origin task/review-flow',
    'git push --force-with-lease origin task/review-flow',
    'git push -f origin task/review-flow',
    'git push origin +task/review-flow:task/review-flow',
  ]) {
    const decision = evaluateRevisionToolUse({ toolName: 'bash', toolArgs: { command } }, authorized);
    assert.equal(decision.permissionDecision, 'deny', command);
    assert.equal(decision.operation, 'force-push', command);
  }
});

test('unauthorized remote mutation is denied before a shell executor can run', () => {
  const denied = resolveRevisionPushPermission(reviewTask(), {
    revisionId: 'revision-denied-push',
    feedback: '暂不推送。',
    prUrl: 'https://example.test/pull/1',
  });
  let remoteMutationCount = 0;
  const executeThroughGuard = (command: string) => {
    const decision = evaluateRevisionToolUse({ toolName: 'bash', toolArgs: { command } }, denied);
    if (decision.permissionDecision !== 'deny') remoteMutationCount += 1;
    return decision;
  };

  assert.equal(executeThroughGuard('git push origin task/review-flow').permissionDecision, 'deny');
  assert.equal(executeThroughGuard("sh -c 'git push origin task/review-flow'").permissionDecision, 'deny');
  assert.equal(executeThroughGuard('env TRACE=1 git push origin task/review-flow').permissionDecision, 'deny');
  assert.equal(executeThroughGuard('git push --force-with-lease origin task/review-flow').permissionDecision, 'deny');
  assert.equal(executeThroughGuard('git send-pack origin refs/heads/task/review-flow').permissionDecision, 'deny');
  assert.equal(executeThroughGuard('gh pr merge 1 --merge').permissionDecision, 'deny');
  assert.equal(remoteMutationCount, 0);
});

test('revision runtime support fails closed when no pre-execution tool guard exists', () => {
  assert.equal(providerSupportsRevisionToolGuard('copilot'), true);
  assert.equal(providerSupportsRevisionToolGuard('claude'), true);
  for (const agentType of ['codex', 'opencode', 'hermes', 'openclaw', 'grok'] as const) {
    assert.equal(providerSupportsRevisionToolGuard(agentType), false, agentType);
  }
});

test('Copilot adapter installs the revision guard even without a worktree', async () => {
  let capturedConfig: { hooks?: { onPreToolUse?: (input: unknown) => unknown } } | undefined;
  const sdkSession = { sessionId: 'sdk-session-1' };
  const provider = new CopilotProvider() as unknown as {
    client: { createSession: (config: unknown) => Promise<typeof sdkSession> };
    createSession: CopilotProvider['createSession'];
  };
  provider.client = {
    createSession: async (config: unknown) => {
      capturedConfig = config as typeof capturedConfig;
      return sdkSession;
    },
  };
  const denied = resolveRevisionPushPermission(reviewTask(), {
    revisionId: 'copilot-adapter-revision',
    feedback: '不要推送。',
    prUrl: 'https://example.test/pull/1',
  });
  await provider.createSession({
    contextId: 'task-1',
    workingDirectory: '/workspace/repo',
    repoPath: '/workspace/repo',
    systemPrompt: 'test',
    onEvent: () => {},
    hooks: {
      onPreToolUse: (input: unknown) => evaluateRevisionToolUse(
        input as { toolName?: unknown; toolArgs?: unknown },
        denied,
      ),
    },
  });

  assert.ok(capturedConfig?.hooks?.onPreToolUse);
  const decision = capturedConfig.hooks.onPreToolUse({
    toolName: 'bash',
    toolArgs: { command: 'git push origin task/review-flow' },
  }) as { permissionDecision?: string };
  assert.equal(decision.permissionDecision, 'deny');
});

test('patched provider adapters wire deny decisions into native pre-execution hooks', async () => {
  const copilotAdapter = await fsPromises.readFile(
    path.join(import.meta.dirname, '../../../node_modules/@codewithdan/agent-sdk-core/dist/providers/copilot.js'),
    'utf8',
  );
  const claudeAdapter = await fsPromises.readFile(
    path.join(import.meta.dirname, '../../../node_modules/@codewithdan/agent-sdk-core/dist/providers/claude.js'),
    'utf8',
  );
  assert.match(copilotAdapter, /consumerHooks\?\.onPreToolUse \|\| \(worktreePath && repoPath\)/);
  assert.match(copilotAdapter, /return changed \? \{ \.\.\.consumerResult, modifiedArgs \} : consumerResult/);
  assert.match(claudeAdapter, /PreToolUse: \[\{/);
  assert.match(claudeAdapter, /permissionDecision: result\.permissionDecision/);
  assert.match(claudeAdapter, /permissionDecisionReason: result\.permissionDecisionReason/);
});

test('revision policy B: explicit no-push feedback overrides an existing PR', () => {
  const prompt = buildAgentExecutionPrompt(reviewTask(), {
    revisionId: 'revision-2',
    feedback: '修复 CI，但不要 push，不要修改 package.json。',
    prUrl: 'https://example.test/pull/1',
  });
  assert.match(prompt, /review feedback explicitly prohibits push/i);
  assert.doesNotMatch(prompt, /git push origin/);
  assert.match(prompt, /不要修改 package\.json/);
  assert.match(prompt, /Never edit a file that the review feedback explicitly says not to modify/);
});

test('revision policy C: explicit no-merge feedback prohibits merge', () => {
  const prompt = buildAgentExecutionPrompt(reviewTask(), {
    revisionId: 'revision-3',
    feedback: '调整实现，不要 merge。',
    prUrl: 'https://example.test/pull/1',
  });
  assert.match(prompt, /review feedback explicitly prohibits merge/i);
  assert.doesNotMatch(prompt, /feedback explicitly authorizes merge/i);
});

test('revision policy D: no PR prohibits push by default', () => {
  const prompt = buildAgentExecutionPrompt(reviewTask(), {
    revisionId: 'revision-4',
    feedback: 'Fix the CI failure',
  });
  assert.match(prompt, /No existing pull request is linked/);
  assert.match(prompt, /Do not push or create a pull request/);
  assert.doesNotMatch(prompt, /git push origin/);
});

test('explicit no-commit feedback overrides the default commit workflow', () => {
  const prompt = buildAgentExecutionPrompt(reviewTask(), {
    revisionId: 'revision-5',
    feedback: 'Update the analysis only. Do not commit.',
    prUrl: 'https://example.test/pull/1',
  });
  assert.match(prompt, /review feedback explicitly prohibits commit/i);
  assert.match(prompt, /Do not create a commit/);
  assert.match(prompt, /must also remain local/i);
  assert.doesNotMatch(prompt, /git push origin/);
});

test('negative merge phrasing is never treated as explicit merge authorization', () => {
  for (const feedback of [
    '不需要 merge。',
    '不可以 merge。',
    'You are not allowed to merge.',
    'You are not authorized to merge.',
  ]) {
    const prompt = buildAgentExecutionPrompt(reviewTask(), {
      revisionId: 'revision-negative-merge',
      feedback,
      prUrl: 'https://example.test/pull/1',
    });
    assert.match(prompt, /review feedback explicitly prohibits merge/i, feedback);
    assert.doesNotMatch(prompt, /feedback explicitly authorizes merge/i, feedback);
  }
});

test('push prohibitions with modifiers override an existing PR', () => {
  for (const feedback of ['不要再自动 push。', "Don't automatically push."]) {
    const prompt = buildAgentExecutionPrompt(reviewTask(), {
      revisionId: 'revision-no-push-modifier',
      feedback,
      prUrl: 'https://example.test/pull/1',
    });
    assert.match(prompt, /review feedback explicitly prohibits push/i, feedback);
    assert.doesNotMatch(prompt, /git push origin/, feedback);
  }
});

test('explicit merge authorization remains opt-in and high-confidence', () => {
  const prompt = buildAgentExecutionPrompt(reviewTask(), {
    revisionId: 'revision-authorized-merge',
    feedback: '请执行 git merge。',
    prUrl: 'https://example.test/pull/1',
  });
  assert.match(prompt, /feedback explicitly authorizes merge/i);
});

test('no-commit revision may finish with local uncommitted changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-no-commit-revision-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  try {
    git(['init', '-b', 'task/review-flow']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Agent Board Test']);
    fs.writeFileSync(path.join(root, 'README.md'), '# initial\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    fs.appendFileSync(path.join(root, 'README.md'), 'local revision\n');
    const task = { ...reviewTask(), repoPath: root };

    assert.equal(inspectRevisionCompletion(task, root, true), undefined);
    assert.throws(
      () => inspectRevisionCompletion(task, root, false),
      /uncommitted changes/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system prompt delegates task permissions to explicit user restrictions', () => {
  const prompt = buildAgentSystemPrompt(reviewTask(), '/workspace/task', '/workspace/task', true);
  assert.match(prompt, /Explicit instructions and restrictions.*override the defaults/i);
  assert.match(prompt, /Unless the current user prompt or review feedback prohibits commits/);
  assert.match(prompt, /does not prohibit push/);
  assert.match(prompt, /Do not merge unless.*explicitly authorizes/i);
  assert.match(prompt, /Never force-push/);
});

test('worktree recovery restores a missing local task branch from origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-revision-worktree-'));
  const repoPath = path.join(root, 'repo');
  const remotePath = path.join(root, 'remote.git');
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  try {
    fs.mkdirSync(repoPath);
    git(repoPath, ['init', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'test@example.invalid']);
    git(repoPath, ['config', 'user.name', 'Agent Board Test']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
    git(repoPath, ['add', 'README.md']);
    git(repoPath, ['commit', '-m', 'initial']);
    fs.mkdirSync(remotePath);
    git(remotePath, ['init', '--bare']);
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'main']);
    git(repoPath, ['checkout', '-b', 'task/revision']);
    fs.writeFileSync(path.join(repoPath, 'revision.txt'), 'remote revision\n');
    git(repoPath, ['add', 'revision.txt']);
    git(repoPath, ['commit', '-m', 'revision']);
    const expectedHead = git(repoPath, ['rev-parse', 'HEAD']);
    git(repoPath, ['push', '-u', 'origin', 'task/revision']);
    git(repoPath, ['checkout', 'main']);
    git(repoPath, ['branch', '-D', 'task/revision']);

    const manager = new AgentManager();
    const task: Task = {
      ...reviewTask('worktree-task'),
      repoPath,
      branchName: 'task/revision',
      baseBranch: 'main',
      useWorktree: true,
      worktreePath: undefined,
    };
    const worktreePath = manager.setupWorktree(task);
    assert.ok(worktreePath);
    assert.equal(git(worktreePath, ['branch', '--show-current']), 'task/revision');
    assert.equal(git(worktreePath, ['rev-parse', 'HEAD']), expectedHead);
    assert.equal(isRevisionCommitOnRemote(task, worktreePath, expectedHead), true);
    task.worktreePath = worktreePath;
    manager.removeWorktree(task);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
