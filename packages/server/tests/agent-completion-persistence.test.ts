import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { AgentProvider, AgentSessionConfig } from '@codewithdan/agent-sdk-core';
import { v4 as uuid } from 'uuid';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { AgentManager } from '../src/services/agent-manager.js';
import { makeStatusCallback, makeWorktreeCallback } from '../src/routes/helpers.js';
import type { Task } from '../src/types.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

async function waitForTerminal(repo: SqliteTaskRepository, id: string): Promise<Task> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const task = await repo.getById(id);
    if (task && (task.agentStatus === 'complete' || task.agentStatus === 'failed')) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('task did not reach a terminal state');
}

test('provider completion with uncommitted code changes fails and preserves the worktree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-completion-persistence-'));
  const repoPath = path.join(root, 'repo');
  const db = new Database(':memory:');
  let finalTask: Task | undefined;
  try {
    fs.mkdirSync(repoPath);
    git(repoPath, ['init', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'test@example.invalid']);
    git(repoPath, ['config', 'user.name', 'Agent Board Test']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# initial\n');
    git(repoPath, ['add', 'README.md']);
    git(repoPath, ['commit', '-m', 'initial']);
    const initialHead = git(repoPath, ['rev-parse', 'HEAD']);

    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    const task: Task = {
      id: 'commit-persistence-failure', projectId: 'default', title: 'Persist code changes',
      description: 'Modify README', priority: 'high', columnId: 'in-progress', agentStatus: 'planning',
      agentType: 'hermes', createdAt: Date.now(), repoPath, branchName: 'task/persistence-failure',
      baseBranch: 'main', useWorktree: true,
    };
    await repo.create(task);

    const provider: AgentProvider = {
      name: 'hermes', displayName: 'Fake Agent', model: 'test',
      async start() {}, async stop() {},
      async createSession(config: AgentSessionConfig) {
        return {
          sessionId: 'fake-session',
          async execute() {
            fs.appendFileSync(path.join(config.workingDirectory, 'README.md'), 'uncommitted work\n');
            return { status: 'complete' as const };
          },
          async send() {}, async abort() {}, async destroy() {},
        };
      },
    };
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const internals = manager as unknown as {
      providers: Map<string, AgentProvider>;
      availableAgents: Array<{ name: 'hermes'; displayName: string; available: boolean }>;
    };
    internals.providers.set('hermes', provider);
    internals.availableAgents = [{ name: 'hermes', displayName: 'Fake Agent', available: true }];

    manager.startAgent(task, makeStatusCallback(repo, task.id), makeWorktreeCallback(repo, task.id));
    finalTask = await waitForTerminal(repo, task.id);

    assert.equal(finalTask.agentStatus, 'failed');
    assert.equal(finalTask.columnId, 'in-progress');
    assert.equal(finalTask.completedAt, undefined);
    assert.equal(finalTask.commitSha, null);
    assert.ok(finalTask.worktreePath && fs.existsSync(finalTask.worktreePath));
    assert.equal(git(finalTask.worktreePath, ['rev-parse', 'HEAD']), initialHead);
    assert.notEqual(git(finalTask.worktreePath, ['status', '--porcelain']), '');
    assert.match(fs.readFileSync(path.join(finalTask.worktreePath, 'README.md'), 'utf8'), /uncommitted work/);
    const events = await repo.getEventsByTaskId(task.id);
    assert.ok(events.some((event) => event.type === 'error' && /uncommitted changes.*preserved/i.test(event.content)));
    assert.equal(events.some((event) => event.type === 'complete'), false);

    manager.removeWorktree(finalTask);
    finalTask = undefined;
  } finally {
    if (finalTask?.worktreePath && fs.existsSync(finalTask.worktreePath)) {
      try { new AgentManager().removeWorktree(finalTask); } catch { /* fixture cleanup only */ }
    }
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('committed code changes persist the exact SHA and result before Complete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-completion-success-'));
  const repoPath = path.join(root, 'repo');
  const db = new Database(':memory:');
  let finalTask: Task | undefined;
  try {
    fs.mkdirSync(repoPath);
    git(repoPath, ['init', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'test@example.invalid']);
    git(repoPath, ['config', 'user.name', 'Agent Board Test']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# initial\n');
    git(repoPath, ['add', 'README.md']);
    git(repoPath, ['commit', '-m', 'initial']);

    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    const task: Task = {
      id: 'commit-persistence-success', projectId: 'default', title: 'Persist committed changes',
      description: 'Modify and commit README', priority: 'high', columnId: 'in-progress', agentStatus: 'planning',
      agentType: 'hermes', createdAt: Date.now(), repoPath, branchName: 'task/persistence-success',
      baseBranch: 'main', useWorktree: true,
    };
    await repo.create(task);

    const provider: AgentProvider = {
      name: 'hermes', displayName: 'Fake Agent', model: 'test',
      async start() {}, async stop() {},
      async createSession(config: AgentSessionConfig) {
        return {
          sessionId: 'fake-session',
          async execute() {
            fs.appendFileSync(path.join(config.workingDirectory, 'README.md'), 'committed work\n');
            git(config.workingDirectory, ['add', 'README.md']);
            git(config.workingDirectory, ['commit', '-m', 'test committed work']);
            config.onEvent({
              id: uuid(), type: 'output', timestamp: Date.now(),
              content: '<task-summary>\n## Completed\nCommitted the README update.\n</task-summary>',
            });
            return { status: 'complete' as const };
          },
          async send() {}, async abort() {}, async destroy() {},
        };
      },
    };
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const internals = manager as unknown as {
      providers: Map<string, AgentProvider>;
      availableAgents: Array<{ name: 'hermes'; displayName: string; available: boolean }>;
    };
    internals.providers.set('hermes', provider);
    internals.availableAgents = [{ name: 'hermes', displayName: 'Fake Agent', available: true }];

    manager.startAgent(task, makeStatusCallback(repo, task.id), makeWorktreeCallback(repo, task.id));
    finalTask = await waitForTerminal(repo, task.id);

    assert.equal(finalTask.agentStatus, 'complete');
    assert.equal(finalTask.columnId, 'review');
    assert.ok(finalTask.completedAt);
    assert.ok(finalTask.worktreePath && fs.existsSync(finalTask.worktreePath));
    assert.equal(finalTask.commitSha, git(finalTask.worktreePath, ['rev-parse', 'HEAD']));
    assert.equal(git(finalTask.worktreePath, ['status', '--porcelain']), '');
    assert.match(finalTask.summary || '', /Committed the README update/);
    const deadline = Date.now() + 1_000;
    let events = await repo.getEventsByTaskId(task.id);
    while (!events.some((event) => event.type === 'complete') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events = await repo.getEventsByTaskId(task.id);
    }
    assert.ok(events.some((event) => event.type === 'complete'));

    manager.removeWorktree(finalTask);
    finalTask = undefined;
  } finally {
    if (finalTask?.worktreePath && fs.existsSync(finalTask.worktreePath)) {
      try { new AgentManager().removeWorktree(finalTask); } catch { /* fixture cleanup only */ }
    }
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('task without a configured repository does not inspect the Board host checkout', async () => {
  const db = new Database(':memory:');
  try {
    migrateSqliteDatabase(db);
    const repo = new SqliteTaskRepository(db);
    const task: Task = {
      id: 'no-repository-task', projectId: 'default', title: 'Answer without code',
      description: 'Return a result only', priority: 'medium', columnId: 'in-progress', agentStatus: 'planning',
      agentType: 'hermes', createdAt: Date.now(),
    };
    await repo.create(task);
    const provider: AgentProvider = {
      name: 'hermes', displayName: 'Fake Agent', model: 'test',
      async start() {}, async stop() {},
      async createSession(config: AgentSessionConfig) {
        return {
          sessionId: 'fake-session',
          async execute() {
            config.onEvent({
              id: uuid(), type: 'output', timestamp: Date.now(),
              content: '<task-summary>\n## Completed\nReturned the requested answer.\n</task-summary>',
            });
            return { status: 'complete' as const };
          },
          async send() {}, async abort() {}, async destroy() {},
        };
      },
    };
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const internals = manager as unknown as {
      providers: Map<string, AgentProvider>;
      availableAgents: Array<{ name: 'hermes'; displayName: string; available: boolean }>;
    };
    internals.providers.set('hermes', provider);
    internals.availableAgents = [{ name: 'hermes', displayName: 'Fake Agent', available: true }];

    manager.startAgent(task, makeStatusCallback(repo, task.id));
    const finalTask = await waitForTerminal(repo, task.id);
    assert.equal(finalTask.agentStatus, 'complete');
    assert.equal(finalTask.columnId, 'review');
    assert.equal(finalTask.commitSha, null);
    assert.match(finalTask.summary || '', /Returned the requested answer/);
  } finally {
    db.close();
  }
});

test('result persistence failure prevents Complete and preserves the committed worktree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-result-persistence-'));
  const repoPath = path.join(root, 'repo');
  const db = new Database(':memory:');
  let finalTask: Task | undefined;
  try {
    fs.mkdirSync(repoPath);
    git(repoPath, ['init', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'test@example.invalid']);
    git(repoPath, ['config', 'user.name', 'Agent Board Test']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# initial\n');
    git(repoPath, ['add', 'README.md']);
    git(repoPath, ['commit', '-m', 'initial']);

    migrateSqliteDatabase(db);
    const realRepo = new SqliteTaskRepository(db);
    const task: Task = {
      id: 'result-persistence-failure', projectId: 'default', title: 'Persist result metadata',
      description: 'Modify and commit README', priority: 'high', columnId: 'in-progress', agentStatus: 'planning',
      agentType: 'hermes', createdAt: Date.now(), repoPath, branchName: 'task/result-persistence-failure',
      baseBranch: 'main', useWorktree: true,
    };
    await realRepo.create(task);

    const repo = new Proxy(realRepo, {
      get(target, property, receiver) {
        if (property !== 'update') return Reflect.get(target, property, receiver);
        return async (id: string, updates: Partial<Task>) => {
          if ('commitSha' in updates) throw new Error('simulated durable result write failure');
          return target.update(id, updates);
        };
      },
    });
    const provider: AgentProvider = {
      name: 'hermes', displayName: 'Fake Agent', model: 'test',
      async start() {}, async stop() {},
      async createSession(config: AgentSessionConfig) {
        return {
          sessionId: 'fake-session',
          async execute() {
            fs.appendFileSync(path.join(config.workingDirectory, 'README.md'), 'committed work\n');
            git(config.workingDirectory, ['add', 'README.md']);
            git(config.workingDirectory, ['commit', '-m', 'test committed work']);
            return { status: 'complete' as const };
          },
          async send() {}, async abort() {}, async destroy() {},
        };
      },
    };
    const manager = new AgentManager();
    manager.initEventPersistence(repo);
    const internals = manager as unknown as {
      providers: Map<string, AgentProvider>;
      availableAgents: Array<{ name: 'hermes'; displayName: string; available: boolean }>;
    };
    internals.providers.set('hermes', provider);
    internals.availableAgents = [{ name: 'hermes', displayName: 'Fake Agent', available: true }];

    manager.startAgent(task, makeStatusCallback(repo, task.id), makeWorktreeCallback(repo, task.id));
    finalTask = await waitForTerminal(realRepo, task.id);

    assert.equal(finalTask.agentStatus, 'failed');
    assert.equal(finalTask.columnId, 'in-progress');
    assert.equal(finalTask.completedAt, undefined);
    assert.equal(finalTask.commitSha, null);
    assert.ok(finalTask.worktreePath && fs.existsSync(finalTask.worktreePath));
    assert.equal(git(finalTask.worktreePath, ['status', '--porcelain']), '');
    assert.notEqual(git(finalTask.worktreePath, ['rev-parse', 'HEAD']), git(repoPath, ['rev-parse', 'HEAD']));
    const events = await realRepo.getEventsByTaskId(task.id);
    assert.ok(events.some((event) => event.type === 'error' && /result write failure/i.test(event.content)));
    assert.equal(events.some((event) => event.type === 'complete'), false);

    manager.removeWorktree(finalTask);
    finalTask = undefined;
  } finally {
    if (finalTask?.worktreePath && fs.existsSync(finalTask.worktreePath)) {
      try { new AgentManager().removeWorktree(finalTask); } catch { /* fixture cleanup only */ }
    }
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
