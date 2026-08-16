import Database from 'better-sqlite3';
import type { Task, Priority, ColumnId, AgentStatus, AgentType, AgentEvent, TaskRevision, TaskRevisionStatus, TaskRevisionPushStatus } from '../types.js';
import type { BeginTaskRevisionInput, FinalizeTaskRevisionInput, TaskRepository, TaskRevisionUpdates } from './types.js';
import { errorMessage } from '../utils.js';

interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  column_id: ColumnId;
  agent_status: AgentStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  repo_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  use_worktree: number | null;
  worktree_path: string | null;
  agent_type: AgentType;
  archived: number;
  project_id: string;
  group_id: string | null;
  group_order: number | null;
  summary: string | null;
  commit_sha: string | null;
  external_source: string | null; external_key: string | null; provenance: string | null;
  run_requested_at: number | null; run_claimed_at: number | null;
  timeout_minutes: number | null;
  pr_url: string | null;
}

interface TaskRevisionRow {
  id: string;
  task_id: string;
  revision_number: number;
  feedback: string;
  status: TaskRevisionStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  previous_summary: string | null;
  agent_summary: string | null;
  commit_sha: string | null;
  push_status: TaskRevisionPushStatus | undefined;
  pushed_at: number | null | undefined;
  released_by_revision_id: string | null | undefined;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    columnId: row.column_id,
    agentStatus: row.agent_status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    repoPath: row.repo_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    useWorktree: row.use_worktree != null ? Boolean(row.use_worktree) : undefined,
    worktreePath: row.worktree_path ?? undefined,
    agentType: row.agent_type,
    archived: Boolean(row.archived),
    groupId: row.group_id ?? undefined,
    groupOrder: row.group_order ?? undefined,
    summary: row.summary ?? null,
    commitSha: row.commit_sha ?? null,
    externalSource: row.external_source ?? undefined, externalKey: row.external_key ?? undefined,
    provenance: row.provenance ? JSON.parse(row.provenance) : undefined,
    runRequestedAt: row.run_requested_at ?? undefined, runClaimedAt: row.run_claimed_at ?? undefined,
    timeoutMinutes: row.timeout_minutes ?? undefined,
    prUrl: row.pr_url ?? null,
  };
}

function rowToRevision(row: TaskRevisionRow): TaskRevision {
  return {
    id: row.id,
    taskId: row.task_id,
    revisionNumber: row.revision_number,
    feedback: row.feedback,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    previousSummary: row.previous_summary,
    agentSummary: row.agent_summary,
    commitSha: row.commit_sha,
    pushStatus: row.push_status ?? 'local',
    pushedAt: row.pushed_at ?? undefined,
    releasedByRevisionId: row.released_by_revision_id ?? null,
  };
}

export class SqliteTaskRepository implements TaskRepository {
  private db: Database.Database;
  private stmts: {
    getAll: Database.Statement;
    getAllIncludingArchived: Database.Statement;
    getArchived: Database.Statement;
    getById: Database.Statement;
    insert: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
    count: Database.Statement;
    insertEvent: Database.Statement;
    getEventsByTaskId: Database.Statement;
    deleteEventsByTaskId: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.stmts = {
      getAll: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND archived = 0 AND group_id IS NULL ORDER BY created_at ASC'),
      getAllIncludingArchived: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND group_id IS NULL ORDER BY created_at ASC'),
      getArchived: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND archived = 1 ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      insert: db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at, started_at, completed_at,
          repo_path, branch_name, base_branch, use_worktree, worktree_path, archived, group_id, group_order, summary, commit_sha, external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes, pr_url)
        VALUES (@id, @project_id, @title, @description, @priority, @column_id, @agent_status, @agent_type, @created_at, @started_at, @completed_at,
          @repo_path, @branch_name, @base_branch, @use_worktree, @worktree_path, @archived, @group_id, @group_order, @summary, @commit_sha, @external_source, @external_key, @provenance, @run_requested_at, @run_claimed_at, @timeout_minutes, @pr_url)
      `),
      update: db.prepare(`
        UPDATE tasks SET
          title = @title,
          description = @description,
          priority = @priority,
          column_id = @column_id,
          agent_status = @agent_status,
          agent_type = @agent_type,
          started_at = @started_at,
          completed_at = @completed_at,
          repo_path = @repo_path,
          branch_name = @branch_name,
          base_branch = @base_branch,
          use_worktree = @use_worktree,
          worktree_path = @worktree_path,
          archived = @archived,
          summary = @summary, commit_sha = @commit_sha, run_requested_at = @run_requested_at, run_claimed_at = @run_claimed_at,
          timeout_minutes = @timeout_minutes,
          pr_url = @pr_url
        WHERE id = @id
      `),
      delete: db.prepare('DELETE FROM tasks WHERE id = ?'),
      count: db.prepare('SELECT COUNT(*) as cnt FROM tasks'),
      insertEvent: db.prepare(`
        INSERT INTO events (id, task_id, type, content, timestamp, metadata)
        VALUES (@id, @task_id, @type, @content, @timestamp, @metadata)
      `),
      getEventsByTaskId: db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY timestamp ASC'),
      deleteEventsByTaskId: db.prepare('DELETE FROM events WHERE task_id = ?'),
    };
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<Task[]> {
    const stmt = includeArchived ? this.stmts.getAllIncludingArchived : this.stmts.getAll;
    return (stmt.all(projectId) as TaskRow[]).map(rowToTask);
  }

  async getById(id: string): Promise<Task | undefined> {
    const row = this.stmts.getById.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async getByExternalIdentity(source: string, key: string): Promise<Task | undefined> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE external_source = ? AND external_key = ?').get(source, key) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async create(task: Task): Promise<Task> {
    this.stmts.insert.run({
      id: task.id,
      project_id: task.projectId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      column_id: task.columnId,
      agent_status: task.agentStatus,
      agent_type: task.agentType ?? 'copilot',
      created_at: task.createdAt,
      started_at: task.startedAt ?? null,
      completed_at: task.completedAt ?? null,
      repo_path: task.repoPath ?? null,
      branch_name: task.branchName ?? null,
      base_branch: task.baseBranch ?? null,
      use_worktree: task.useWorktree != null ? (task.useWorktree ? 1 : 0) : null,
      worktree_path: task.worktreePath ?? null,
      archived: task.archived ? 1 : 0,
      group_id: task.groupId ?? null,
      group_order: task.groupOrder ?? null,
      summary: task.summary ?? null, external_source: task.externalSource ?? null, external_key: task.externalKey ?? null,
      commit_sha: task.commitSha ?? null,
      provenance: task.provenance ? JSON.stringify(task.provenance) : null, run_requested_at: task.runRequestedAt ?? null, run_claimed_at: task.runClaimedAt ?? null,
      timeout_minutes: task.timeoutMinutes ?? null,
      pr_url: task.prUrl ?? null,
    });
    return task;
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    try { await this.create(task); return { task, created: true }; } catch (err) {
      if (task.externalSource && task.externalKey && err instanceof Error && err.message.includes('UNIQUE')) {
        const existing = await this.getByExternalIdentity(task.externalSource, task.externalKey); if (existing) return { task: existing, created: false };
      } throw err;
    }
  }
  async requestRun(id: string, at: number) {
    const staleBefore = at - 30_000;
    const r = this.db.prepare(`UPDATE tasks SET
      run_requested_at=?,
      run_claimed_at=NULL
      WHERE id=? AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND (run_requested_at IS NULL OR run_requested_at < ?)`).run(at, id, staleBefore, staleBefore);
    return r.changes ? this.getById(id) : undefined;
  }
  async claimRun(id: string, at: number) { const staleBefore=at-30_000; const r=this.db.prepare("UPDATE tasks SET run_claimed_at=? WHERE id=? AND run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND agent_status IN ('idle','planning','failed')").run(at,id,staleBefore); return r.changes ? this.getById(id) : undefined; }
  async clearRun(id: string) { this.db.prepare('UPDATE tasks SET run_requested_at=NULL, run_claimed_at=NULL WHERE id=?').run(id); return this.getById(id); }
  async getPendingRuns(staleBefore = Date.now()-30_000) { return (this.db.prepare("SELECT * FROM tasks WHERE run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND agent_status IN ('idle','planning') ORDER BY run_requested_at").all(staleBefore) as TaskRow[]).map(rowToTask); }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    return this.db.transaction(() => {
      const row = this.stmts.getById.get(id) as TaskRow | undefined;
      const existing = row ? rowToTask(row) : undefined;
      if (!existing) return undefined;
      const merged = { ...existing, ...updates };
      this.stmts.update.run({
        id,
        title: merged.title,
        description: merged.description,
        priority: merged.priority,
        column_id: merged.columnId,
        agent_status: merged.agentStatus,
        agent_type: merged.agentType,
        started_at: merged.startedAt ?? null,
        completed_at: merged.completedAt ?? null,
        repo_path: merged.repoPath ?? null,
        branch_name: merged.branchName ?? null,
        base_branch: merged.baseBranch ?? null,
        use_worktree: merged.useWorktree != null ? (merged.useWorktree ? 1 : 0) : null,
        worktree_path: merged.worktreePath ?? null,
        archived: merged.archived ? 1 : 0,
        summary: merged.summary ?? null, commit_sha: merged.commitSha ?? null, run_requested_at: merged.runRequestedAt ?? null, run_claimed_at: merged.runClaimedAt ?? null,
        timeout_minutes: merged.timeoutMinutes ?? null,
        pr_url: merged.prUrl ?? null,
      });
      return merged;
    })();
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async count(): Promise<number> {
    const row = this.stmts.count.get() as { cnt: number };
    return row.cnt;
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    this.stmts.insertEvent.run({
      id: event.id,
      task_id: event.taskId,
      type: event.type,
      content: event.content,
      timestamp: event.timestamp,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    });
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    const rows = this.stmts.getEventsByTaskId.all(taskId) as Array<{
      id: string;
      task_id: string;
      type: string;
      content: string;
      timestamp: number;
      metadata: string | null;
    }>;
    return rows.map((row) => {
      let metadata: AgentEvent['metadata'] | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch (err: unknown) {
          // Log malformed metadata
          console.warn(`[sqlite] Failed to parse metadata for event ${row.id}:`, errorMessage(err));
        }
      }
      return {
        id: row.id,
        taskId: row.task_id,
        type: row.type as AgentEvent['type'],
        content: row.content,
        timestamp: row.timestamp,
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async deleteEventsByTaskId(taskId: string): Promise<void> {
    this.stmts.deleteEventsByTaskId.run(taskId);
  }

  async getArchivedTasks(projectId = 'default'): Promise<Task[]> {
    return (this.stmts.getArchived.all(projectId) as TaskRow[]).map(rowToTask);
  }

  async beginRevision(input: BeginTaskRevisionInput): Promise<{ task: Task; revision: TaskRevision } | undefined> {
    return this.db.transaction(() => {
      const taskRow = this.stmts.getById.get(input.taskId) as TaskRow | undefined;
      if (!taskRow || taskRow.column_id !== 'review') return undefined;

      const next = this.db.prepare(
        'SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number FROM task_revisions WHERE task_id = ?',
      ).get(input.taskId) as { revision_number: number };
      this.db.prepare(`
        INSERT INTO task_revisions (
          id, task_id, revision_number, feedback, status, created_at,
          started_at, completed_at, previous_summary, agent_summary, commit_sha,
          push_status, pushed_at, released_by_revision_id
        ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL, NULL, 'local', NULL, NULL)
      `).run(input.id, input.taskId, next.revision_number, input.feedback, input.createdAt, taskRow.summary);

      this.db.prepare(`
        UPDATE tasks SET
          column_id = 'in-progress', agent_status = 'planning',
          started_at = ?, completed_at = NULL,
          run_requested_at = ?, run_claimed_at = NULL
        WHERE id = ?
      `).run(input.createdAt, input.createdAt, input.taskId);

      const updatedTask = this.stmts.getById.get(input.taskId) as TaskRow;
      const revisionRow = this.db.prepare('SELECT * FROM task_revisions WHERE id = ?').get(input.id) as TaskRevisionRow;
      return { task: rowToTask(updatedTask), revision: rowToRevision(revisionRow) };
    })();
  }

  async getRevisionsByTaskId(taskId: string): Promise<TaskRevision[]> {
    const rows = this.db.prepare(`
      SELECT * FROM task_revisions
      WHERE task_id = ?
      ORDER BY revision_number ASC, created_at ASC, id ASC
    `).all(taskId) as TaskRevisionRow[];
    return rows.map(rowToRevision);
  }

  async getActiveRevisionByTaskId(taskId: string): Promise<TaskRevision | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM task_revisions
      WHERE task_id = ? AND status IN ('pending', 'in-progress')
      ORDER BY revision_number DESC
      LIMIT 1
    `).get(taskId) as TaskRevisionRow | undefined;
    return row ? rowToRevision(row) : undefined;
  }

  async hasHeldRevisions(taskId: string): Promise<boolean> {
    const row = this.db.prepare(`
      SELECT 1 FROM task_revisions
      WHERE task_id = ? AND push_status = 'held'
      LIMIT 1
    `).get(taskId);
    return Boolean(row);
  }

  async updateRevision(id: string, updates: TaskRevisionUpdates): Promise<TaskRevision | undefined> {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM task_revisions WHERE id = ?').get(id) as TaskRevisionRow | undefined;
      if (!row) return undefined;
      const existing = rowToRevision(row);
      const merged = { ...existing, ...updates };
      this.db.prepare(`
        UPDATE task_revisions SET
          status = ?, started_at = ?, completed_at = ?, agent_summary = ?, commit_sha = ?,
          push_status = ?, pushed_at = ?, released_by_revision_id = ?
        WHERE id = ?
      `).run(
        merged.status,
        merged.startedAt ?? null,
        merged.completedAt ?? null,
        merged.agentSummary ?? null,
        merged.commitSha ?? null,
        merged.pushStatus,
        merged.pushedAt ?? null,
        merged.releasedByRevisionId ?? null,
        id,
      );
      const updated = this.db.prepare('SELECT * FROM task_revisions WHERE id = ?').get(id) as TaskRevisionRow;
      return rowToRevision(updated);
    })();
  }

  async finalizeRevision(id: string, input: FinalizeTaskRevisionInput): Promise<TaskRevision | undefined> {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM task_revisions WHERE id = ?').get(id) as TaskRevisionRow | undefined;
      if (!row) return undefined;
      if (input.releaseHeldRevisions) {
        this.db.prepare(`
          UPDATE task_revisions SET
            push_status = 'released', pushed_at = ?, released_by_revision_id = ?
          WHERE task_id = ? AND id <> ? AND push_status = 'held'
        `).run(input.pushedAt ?? input.completedAt, id, row.task_id, id);
        this.db.prepare(`
          UPDATE task_revisions SET push_status = 'pushed', pushed_at = ?
          WHERE task_id = ? AND id <> ? AND push_status = 'local' AND commit_sha IS NOT NULL
        `).run(input.pushedAt ?? input.completedAt, row.task_id, id);
      }
      this.db.prepare(`
        UPDATE task_revisions SET
          status = ?, completed_at = ?, agent_summary = ?, commit_sha = ?,
          push_status = ?, pushed_at = ?, released_by_revision_id = NULL
        WHERE id = ?
      `).run(
        input.status,
        input.completedAt,
        input.agentSummary,
        input.commitSha,
        input.pushStatus,
        input.pushedAt ?? null,
        id,
      );
      const updated = this.db.prepare('SELECT * FROM task_revisions WHERE id = ?').get(id) as TaskRevisionRow;
      return rowToRevision(updated);
    })();
  }
}
