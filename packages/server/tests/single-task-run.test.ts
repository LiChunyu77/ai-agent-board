import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { createAgentRouter } from '../src/routes/agent.js';
import type { Task, AgentStatus, AgentEvent } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

function createTestApp(options: {
  repo?: TaskRepository;
  agentManager?: AgentManager;
} = {}) {
  const db = new Database(':memory:');
  migrateSqliteDatabase(db);
  const repo = options.repo ?? new SqliteTaskRepository(db);

  const startAgentCalls: Array<{ task: Task; onStatusChange: (status: AgentStatus) => void | Promise<void> }> = [];
  const resetEventsCalls: string[] = [];
  const fakeAgentManager = options.agentManager ?? ({
    runningTaskIds: new Set<string>(),
    resetEvents: (taskId: string) => { resetEventsCalls.push(taskId); },
    isRunning: (taskId: string) => fakeAgentManager.runningTaskIds.has(taskId),
    startAgent: (task: Task, onStatusChange: (status: AgentStatus) => void | Promise<void>) => {
      fakeAgentManager.runningTaskIds.add(task.id);
      startAgentCalls.push({ task, onStatusChange });
    },
    stopAgent: async (_taskId: string) => false,
    getEvents: async (_taskId: string) => [],
    sendMessage: async (_taskId: string, _message: string) => false,
  } as unknown as AgentManager);

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createAgentRouter(repo, fakeAgentManager));

  return { db, repo, app, fakeAgentManager, startAgentCalls, resetEventsCalls };
}

async function postRun(app: express.Express, taskId: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = { method: 'POST', url: `/api/tasks/${taskId}/run`, headers: {} } as any;
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string | string[]>,
      body: undefined as any,
      status(code: number) { this.statusCode = code; return this; },
      json(value: any) { this.body = value; resolve({ status: this.statusCode, body: value }); },
      send(value: any) { this.body = value; resolve({ status: this.statusCode, body: value }); },
      set(field: string, value: string) { this.headers[field] = value; return this; },
      setHeader(field: string, value: string | string[]) { this.headers[field] = value; },
      getHeader(field: string) { return this.headers[field]; },
      removeHeader(field: string) { delete this.headers[field]; },
      end() { resolve({ status: this.statusCode, body: this.body }); },
    } as any;
    app(req, res, (err: unknown) => {
      if (err) reject(err);
      else if (res.body === undefined && !res.headersSent) resolve({ status: res.statusCode, body: undefined });
    });
  });
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'default',
    title: 'Test task',
    description: '',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'idle',
    agentType: 'copilot',
    createdAt: Date.now(),
    ...overrides,
  };
}

function findErrorEvent(events: AgentEvent[]): AgentEvent | undefined {
  return events.find(e => e.type === 'error');
}

test('POST /:id/run on an idle task starts a run', async () => {
  const { db, repo, app, fakeAgentManager, startAgentCalls, resetEventsCalls } = createTestApp();
  try {
    const task = baseTask({ id: 'idle-run' });
    await repo.create(task);

    const { status } = await postRun(app, task.id);

    const updated = await repo.getById(task.id);
    assert.ok(updated);
    assert.equal(status, 200);
    assert.equal(updated.agentStatus, 'planning');
    assert.equal(startAgentCalls.length, 1);
    assert.ok(fakeAgentManager.isRunning(task.id));
    assert.ok(updated.runRequestedAt, 'runRequestedAt should be set');
    assert.ok(updated.runClaimedAt, 'runClaimedAt should be set');
    assert.deepStrictEqual(resetEventsCalls, [task.id], 'resetEvents should be called after claim');
  } finally {
    db.close();
  }
});

test('POST /:id/run while already running returns 409 and does not start another agent', async () => {
  const { db, repo, app, fakeAgentManager, startAgentCalls, resetEventsCalls } = createTestApp();
  try {
    const task = baseTask({ id: 'already-running', agentStatus: 'executing' });
    await repo.create(task);
    fakeAgentManager.runningTaskIds.add(task.id);

    const { status, body } = await postRun(app, task.id);

    assert.equal(status, 409);
    assert.ok(body.error);
    assert.equal(startAgentCalls.length, 0);
    assert.deepStrictEqual(resetEventsCalls, [], 'resetEvents must not be called when run is rejected');
  } finally {
    db.close();
  }
});

test('POST /:id/run on an orphaned executing task recovers to failed, persists an error event, clears the claim, and returns 409', async () => {
  const { db, repo, app, startAgentCalls, resetEventsCalls } = createTestApp();
  try {
    const task = baseTask({ id: 'orphan-exec', agentStatus: 'executing' });
    await repo.create(task);

    const { status, body } = await postRun(app, task.id);

    const updated = await repo.getById(task.id);
    assert.ok(updated, 'task should still exist');
    assert.equal(status, 409, `expected 409, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(updated.agentStatus, 'failed', 'orphaned executing state should be failed');
    assert.equal(startAgentCalls.length, 0, 'no new agent should start');
    assert.equal(updated.runRequestedAt, undefined, 'runRequestedAt must be cleared');
    assert.equal(updated.runClaimedAt, undefined, 'runClaimedAt must be cleared');
    assert.ok(updated.completedAt, 'completedAt should be set on failure');
    assert.deepStrictEqual(resetEventsCalls, [], 'resetEvents must not be called for orphan recovery');

    const events = await repo.getEventsByTaskId(task.id);
    const error = findErrorEvent(events);
    assert.ok(error, 'an error event should be persisted');
    assert.match(error.content, /Agent session lost/);
  } finally {
    db.close();
  }
});

test('POST /:id/run on an orphaned planning task recovers to failed, persists an error event, clears the claim, and returns 409', async () => {
  const { db, repo, app, startAgentCalls, resetEventsCalls } = createTestApp();
  try {
    const task = baseTask({ id: 'orphan-plan', agentStatus: 'planning' });
    await repo.create(task);

    const { status, body } = await postRun(app, task.id);

    const updated = await repo.getById(task.id);
    assert.ok(updated);
    assert.equal(status, 409, `expected 409, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(updated.agentStatus, 'failed');
    assert.equal(startAgentCalls.length, 0);
    assert.equal(updated.runRequestedAt, undefined);
    assert.equal(updated.runClaimedAt, undefined);
    assert.deepStrictEqual(resetEventsCalls, [], 'resetEvents must not be called for orphan recovery');

    const events = await repo.getEventsByTaskId(task.id);
    assert.ok(findErrorEvent(events));
  } finally {
    db.close();
  }
});

test('POST /:id/run on a complete task returns 409 and clears stale run claims', async () => {
  const { db, repo, app, startAgentCalls, resetEventsCalls } = createTestApp();
  try {
    const now = Date.now();
    const task = baseTask({
      id: 'terminal-run',
      agentStatus: 'complete',
      runRequestedAt: now,
      runClaimedAt: now,
    });
    await repo.create(task);

    const { status, body } = await postRun(app, task.id);

    const updated = await repo.getById(task.id);
    assert.ok(updated);
    assert.equal(status, 409);
    assert.ok(body.error);
    assert.equal(startAgentCalls.length, 0);
    assert.equal(updated.runRequestedAt, undefined, 'stale runRequestedAt must be cleared');
    assert.equal(updated.runClaimedAt, undefined, 'stale runClaimedAt must be cleared');
    assert.equal(updated.agentStatus, 'complete');
    assert.deepStrictEqual(resetEventsCalls, [], 'resetEvents must not be called for complete tasks');
  } finally {
    db.close();
  }
});

test('POST /:id/run retries a failed task through planning', async () => {
  const { db, repo, app, fakeAgentManager, startAgentCalls, resetEventsCalls } = createTestApp();
  try {
    const task = baseTask({ id: 'failed-retry', agentStatus: 'failed' });
    await repo.create(task);

    const { status } = await postRun(app, task.id);

    const updated = await repo.getById(task.id);
    assert.ok(updated);
    assert.equal(status, 200);
    assert.equal(updated.agentStatus, 'planning');
    assert.equal(startAgentCalls.length, 1);
    assert.ok(fakeAgentManager.isRunning(task.id));
    assert.ok(updated.runRequestedAt);
    assert.ok(updated.runClaimedAt);
    assert.deepStrictEqual(resetEventsCalls, [task.id], 'resetEvents should be called after claim');
  } finally {
    db.close();
  }
});

test('POST /:id/run with an existing valid claim returns 409 without touching events or the claim', async () => {
  const { db, repo, app, startAgentCalls, resetEventsCalls } = createTestApp();
  try {
    const now = Date.now();
    const task = baseTask({
      id: 'existing-claim',
      agentStatus: 'idle',
      runRequestedAt: now,
      runClaimedAt: now + 60_000,
    });
    await repo.create(task);

    const { status, body } = await postRun(app, task.id);

    assert.equal(status, 409, `expected 409, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(startAgentCalls.length, 0);
    assert.deepStrictEqual(resetEventsCalls, [], 'resetEvents must not be called when CAS fails');

    const updated = await repo.getById(task.id);
    assert.ok(updated);
    assert.equal(updated.runRequestedAt, now, 'winner runRequestedAt must not be overwritten');
    assert.equal(updated.runClaimedAt, now + 60_000, 'winner runClaimedAt must not be cleared');
  } finally {
    db.close();
  }
});

test('POST /:id/run with a synchronously unavailable agent fails visibly and clears durable run claim', async () => {
  const db = new Database(':memory:');
  migrateSqliteDatabase(db);
  const repo = new SqliteTaskRepository(db);

  const startAgentCalls: Array<{ task: Task; onStatusChange: (status: AgentStatus) => void | Promise<void> }> = [];
  const fakeAgentManager = {
    runningTaskIds: new Set<string>(),
    resetEvents: (_taskId: string) => {},
    isRunning: (taskId: string) => fakeAgentManager.runningTaskIds.has(taskId),
    startAgent: (task: Task, onStatusChange: (status: AgentStatus) => void | Promise<void>) => {
      fakeAgentManager.runningTaskIds.add(task.id);
      startAgentCalls.push({ task, onStatusChange });
      // Simulate synchronous terminal failure (agent unavailable)
      void onStatusChange('failed');
      fakeAgentManager.runningTaskIds.delete(task.id);
    },
    stopAgent: async (_taskId: string) => false,
    getEvents: async (_taskId: string) => [],
    sendMessage: async (_taskId: string, _message: string) => false,
  } as unknown as AgentManager;

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createAgentRouter(repo, fakeAgentManager));

  try {
    const task = baseTask({ id: 'sync-unavailable', agentStatus: 'idle', agentType: 'copilot' });
    await repo.create(task);

    const { status } = await postRun(app, task.id);

    const updated = await repo.getById(task.id);
    assert.ok(updated);
    assert.equal(status, 200);
    assert.equal(updated.agentStatus, 'failed');
    assert.equal(updated.runRequestedAt, undefined, 'runRequestedAt must be cleared on terminal failure');
    assert.equal(updated.runClaimedAt, undefined, 'runClaimedAt must be cleared on terminal failure');
  } finally {
    db.close();
  }
});

test('POST /:id/run with an asynchronously terminal failure cleans the durable run claim', async () => {
  const db = new Database(':memory:');
  migrateSqliteDatabase(db);
  const repo = new SqliteTaskRepository(db);

  const startAgentCalls: Array<{ task: Task; onStatusChange: (status: AgentStatus) => void | Promise<void> }> = [];
  const fakeAgentManager = {
    runningTaskIds: new Set<string>(),
    resetEvents: (_taskId: string) => {},
    isRunning: (taskId: string) => fakeAgentManager.runningTaskIds.has(taskId),
    startAgent: async (task: Task, onStatusChange: (status: AgentStatus) => void | Promise<void>) => {
      fakeAgentManager.runningTaskIds.add(task.id);
      startAgentCalls.push({ task, onStatusChange });
      await new Promise(resolve => setImmediate(resolve));
      fakeAgentManager.runningTaskIds.delete(task.id);
      await onStatusChange('failed');
    },
    stopAgent: async (_taskId: string) => false,
    getEvents: async (_taskId: string) => [],
    sendMessage: async (_taskId: string, _message: string) => false,
  } as unknown as AgentManager;

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createAgentRouter(repo, fakeAgentManager));

  try {
    const task = baseTask({ id: 'async-terminal', agentStatus: 'idle' });
    await repo.create(task);

    const { status } = await postRun(app, task.id);

    // The route responds before the async failure callback runs.
    assert.equal(status, 200);

    // Flush the async status callback.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const updated = await repo.getById(task.id);
    assert.ok(updated);
    assert.equal(updated.agentStatus, 'failed');
    assert.equal(updated.runRequestedAt, undefined, 'runRequestedAt must be cleared after async terminal failure');
    assert.equal(updated.runClaimedAt, undefined, 'runClaimedAt must be cleared after async terminal failure');
  } finally {
    db.close();
  }
});

test('concurrent requestRun/claimRun preserves the winning claim and does not overwrite its runRequestedAt', async () => {
  const db = new Database(':memory:');
  migrateSqliteDatabase(db);
  const repo = new SqliteTaskRepository(db);

  try {
    const task = baseTask({ id: 'concurrent-claim', agentStatus: 'idle' });
    await repo.create(task);

    const now = Date.now();
    const requestA = (async () => {
      const r = await repo.requestRun(task.id, now);
      return r;
    })();
    const requestB = (async () => {
      const r = await repo.requestRun(task.id, now + 1);
      return r;
    })();
    const [a, b] = await Promise.all([requestA, requestB]);

    const winner = a ?? b;
    assert.ok(winner, 'one requestRun should win');
    assert.equal([a, b].filter(Boolean).length, 1, 'only one requestRun should succeed');

    const claimed = await repo.claimRun(task.id, now + 2);
    assert.ok(claimed, 'winner should be able to claim');

    const latest = await repo.getById(task.id);
    assert.ok(latest);
    assert.equal(latest.runRequestedAt, winner.runRequestedAt, 'winner runRequestedAt must not be overwritten');
    assert.equal(latest.runClaimedAt, claimed.runClaimedAt, 'winner claim must survive');
  } finally {
    db.close();
  }
});

test('requestRun CAS refuses to overwrite a fresh intent/claim and clears stale intent/claim', async () => {
  const db = new Database(':memory:');
  migrateSqliteDatabase(db);
  const repo = new SqliteTaskRepository(db);

  try {
    const now = Date.now();
    const task = baseTask({ id: 'cas-claim' });
    await repo.create(task);

    // Fresh (unexpired) claim must cause requestRun to fail without changes.
    await repo.update(task.id, { runRequestedAt: now - 60_000, runClaimedAt: now + 60_000 });
    const blocked = await repo.requestRun(task.id, now);
    assert.equal(blocked, undefined, 'requestRun must not overwrite a valid claim');

    let latest = await repo.getById(task.id);
    assert.ok(latest);
    assert.equal(latest.runRequestedAt, now - 60_000, 'existing runRequestedAt must be preserved');
    assert.equal(latest.runClaimedAt, now + 60_000, 'existing runClaimedAt must be preserved');

    // Stale intent/claim older than the 30s lease must be cleared.
    await repo.update(task.id, { runRequestedAt: now - 60_000, runClaimedAt: now - 60_000 });
    const allowed = await repo.requestRun(task.id, now);
    assert.ok(allowed, 'requestRun should succeed against stale intent/claim');
    assert.equal(allowed.runRequestedAt, now);
    assert.equal(allowed.runClaimedAt, undefined, 'stale claim should be cleared');

    latest = await repo.getById(task.id);
    assert.equal(latest.runRequestedAt, now);
    assert.equal(latest.runClaimedAt, undefined);
  } finally {
    db.close();
  }
});

test('claimRun allows a failed task to be claimed for retry', async () => {
  const db = new Database(':memory:');
  migrateSqliteDatabase(db);
  const repo = new SqliteTaskRepository(db);

  try {
    const task = baseTask({ id: 'failed-claim', agentStatus: 'failed' });
    await repo.create(task);

    const unclaimed = await repo.claimRun(task.id, Date.now());
    assert.equal(unclaimed, undefined, 'claimRun requires a run request first');

    await repo.requestRun(task.id, Date.now());
    const claimed = await repo.claimRun(task.id, Date.now());
    assert.ok(claimed);
    assert.equal(claimed.agentStatus, 'failed');
    assert.ok(claimed.runClaimedAt);
  } finally {
    db.close();
  }
});

test('claim persistence failure cleans the durable run claim and returns 500', async () => {
  const db = new Database(':memory:');
  migrateSqliteDatabase(db);
  const realRepo = new SqliteTaskRepository(db);

  const startAgentCalls: Array<{ task: Task; onStatusChange: (status: AgentStatus) => void | Promise<void> }> = [];
  const resetEventsCalls: string[] = [];
  const fakeAgentManager = {
    runningTaskIds: new Set<string>(),
    resetEvents: (taskId: string) => { resetEventsCalls.push(taskId); },
    isRunning: (taskId: string) => fakeAgentManager.runningTaskIds.has(taskId),
    startAgent: (task: Task, onStatusChange: (status: AgentStatus) => void | Promise<void>) => {
      fakeAgentManager.runningTaskIds.add(task.id);
      startAgentCalls.push({ task, onStatusChange });
    },
    stopAgent: async (_taskId: string) => false,
    getEvents: async (_taskId: string) => [],
    sendMessage: async (_taskId: string, _message: string) => false,
  } as unknown as AgentManager;

  // Repo wrapper that fails the planning-state persistence but still allows clearRun.
  const failingRepo = new Proxy(realRepo, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return async (id: string, updates: Partial<Task>) => {
          if (updates.agentStatus === 'planning') {
            return undefined;
          }
          return target.update(id, updates);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as TaskRepository;

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createAgentRouter(failingRepo, fakeAgentManager));

  try {
    const task = baseTask({ id: 'persist-fail', agentStatus: 'idle' });
    await realRepo.create(task);

    const { status, body } = await postRun(app, task.id);

    assert.equal(status, 500, `expected 500, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(startAgentCalls.length, 0, 'agent must not start when persistence fails');
    assert.deepStrictEqual(resetEventsCalls, [], 'resetEvents must not be called when planning persistence fails');

    const updated = await realRepo.getById(task.id);
    assert.ok(updated);
    assert.equal(updated.runRequestedAt, undefined, 'runRequestedAt must be cleaned after persistence failure');
    assert.equal(updated.runClaimedAt, undefined, 'runClaimedAt must be cleaned after persistence failure');
  } finally {
    db.close();
  }
});
