import { Pool } from 'pg';
import type { Task, Priority, ColumnId, AgentStatus, AgentType, AgentEvent, TaskRevision, TaskRevisionStatus, TaskRevisionPushStatus } from '../types.js';
import type { BeginTaskRevisionInput, FinalizeTaskRevisionInput, TaskRepository, TaskRevisionUpdates } from './types.js';
import { isValidPriority, isValidColumnId, isValidAgentStatus, isValidAgentType } from '@ai-agent-board/shared/constants.js';
import { errorMessage } from '../utils.js';

interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: string;
  column_id: string;
  agent_status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  repo_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  use_worktree: boolean | null;
  worktree_path: string | null;
  agent_type: string;
  archived: boolean;
  project_id: string;
  group_id: string | null;
  group_order: number | null;
  summary: string | null;
  commit_sha: string | null;
  external_source: string | null; external_key: string | null; provenance: string | null;
  run_requested_at: string | null; run_claimed_at: string | null;
  timeout_minutes: number | null;
  pr_url: string | null;
}

interface TaskRevisionRow {
  id: string;
  task_id: string;
  revision_number: number;
  feedback: string;
  status: TaskRevisionStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  previous_summary: string | null;
  agent_summary: string | null;
  commit_sha: string | null;
  push_status?: TaskRevisionPushStatus;
  pushed_at?: string | null;
  released_by_revision_id?: string | null;
}

function rowToTask(row: TaskRow): Task {
  // Validate and log warnings for invalid values
  if (!isValidPriority(row.priority)) {
    console.warn(`[postgres] Invalid priority in database: ${row.priority} for task ${row.id}, using 'medium' as default`);
    row.priority = 'medium';
  }

  if (!isValidColumnId(row.column_id)) {
    console.warn(`[postgres] Invalid column_id in database: ${row.column_id} for task ${row.id}, using 'backlog' as default`);
    row.column_id = 'backlog';
  }

  if (!isValidAgentStatus(row.agent_status)) {
    console.warn(`[postgres] Invalid agent_status in database: ${row.agent_status} for task ${row.id}, using 'idle' as default`);
    row.agent_status = 'idle';
  }

  if (!isValidAgentType(row.agent_type)) {
    console.warn(`[postgres] Invalid agent_type in database: ${row.agent_type} for task ${row.id}, using 'copilot' as default`);
    row.agent_type = 'copilot';
  }

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority,
    columnId: row.column_id as ColumnId,
    agentStatus: row.agent_status as AgentStatus,
    createdAt: Number(row.created_at),
    startedAt: row.started_at != null ? Number(row.started_at) : undefined,
    completedAt: row.completed_at != null ? Number(row.completed_at) : undefined,
    repoPath: row.repo_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    useWorktree: row.use_worktree ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    agentType: row.agent_type as AgentType,
    archived: row.archived,
    groupId: row.group_id ?? undefined,
    groupOrder: row.group_order ?? undefined,
    summary: row.summary ?? null, commitSha: row.commit_sha ?? null, externalSource: row.external_source ?? undefined, externalKey: row.external_key ?? undefined,
    provenance: row.provenance ? JSON.parse(row.provenance) : undefined,
    runRequestedAt: row.run_requested_at != null ? Number(row.run_requested_at) : undefined, runClaimedAt: row.run_claimed_at != null ? Number(row.run_claimed_at) : undefined,
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
    createdAt: Number(row.created_at),
    startedAt: row.started_at != null ? Number(row.started_at) : undefined,
    completedAt: row.completed_at != null ? Number(row.completed_at) : undefined,
    previousSummary: row.previous_summary,
    agentSummary: row.agent_summary,
    commitSha: row.commit_sha,
    pushStatus: row.push_status ?? 'local',
    pushedAt: row.pushed_at != null ? Number(row.pushed_at) : undefined,
    releasedByRevisionId: row.released_by_revision_id ?? null,
  };
}

export class PostgresTaskRepository implements TaskRepository {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<Task[]> {
    const query = includeArchived
      ? 'SELECT * FROM tasks WHERE project_id = $1 AND group_id IS NULL ORDER BY created_at ASC'
      : 'SELECT * FROM tasks WHERE project_id = $1 AND archived = FALSE AND group_id IS NULL ORDER BY created_at ASC';
    const { rows } = await this.pool.query<TaskRow>(query, [projectId]);
    return rows.map(rowToTask);
  }

  async getById(id: string): Promise<Task | undefined> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [id]
    );
    return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  async getByExternalIdentity(source: string, key: string): Promise<Task | undefined> {
    const { rows } = await this.pool.query<TaskRow>('SELECT * FROM tasks WHERE external_source=$1 AND external_key=$2', [source,key]); return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  async create(task: Task): Promise<Task> {
    await this.pool.query(
      `INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type,
        created_at, started_at, completed_at, repo_path, branch_name, base_branch, use_worktree, worktree_path, archived,
        group_id, group_order, summary, commit_sha, external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes, pr_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)`,
      [
        task.id,
        task.projectId,
        task.title,
        task.description,
        task.priority,
        task.columnId,
        task.agentStatus,
        task.agentType ?? 'copilot',
        task.createdAt,
        task.startedAt ?? null,
        task.completedAt ?? null,
        task.repoPath ?? null,
        task.branchName ?? null,
        task.baseBranch ?? null,
        task.useWorktree ?? null,
        task.worktreePath ?? null,
        task.archived ?? false,
        task.groupId ?? null,
        task.groupOrder ?? null,
        task.summary ?? null, task.commitSha ?? null, task.externalSource ?? null, task.externalKey ?? null, task.provenance ? JSON.stringify(task.provenance) : null, task.runRequestedAt ?? null, task.runClaimedAt ?? null, task.timeoutMinutes ?? null, task.prUrl ?? null,
      ]
    );
    return task;
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    try { await this.create(task); return {task,created:true}; } catch (err: any) {
      if (err?.code === '23505' && task.externalSource && task.externalKey) { const existing=await this.getByExternalIdentity(task.externalSource,task.externalKey); if(existing) return {task:existing,created:false}; } throw err;
    }
  }
  async requestRun(id:string,at:number) { const staleBefore=at-30_000; const {rows}=await this.pool.query<TaskRow>('UPDATE tasks SET run_requested_at=$1,run_claimed_at=NULL WHERE id=$2 AND (run_claimed_at IS NULL OR run_claimed_at < $3) AND (run_requested_at IS NULL OR run_requested_at < $3) RETURNING *',[at,id,staleBefore]); return rows[0]?rowToTask(rows[0]):undefined; }
  async claimRun(id:string,at:number) { const staleBefore=at-30_000; const {rows}=await this.pool.query<TaskRow>("UPDATE tasks SET run_claimed_at=$1 WHERE id=$2 AND run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < $3) AND agent_status IN ('idle','planning','failed') RETURNING *",[at,id,staleBefore]); return rows[0]?rowToTask(rows[0]):undefined; }
  async clearRun(id:string) { const {rows}=await this.pool.query<TaskRow>('UPDATE tasks SET run_requested_at=NULL,run_claimed_at=NULL WHERE id=$1 RETURNING *',[id]); return rows[0]?rowToTask(rows[0]):undefined; }
  async getPendingRuns(staleBefore=Date.now()-30_000) { const {rows}=await this.pool.query<TaskRow>("SELECT * FROM tasks WHERE run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < $1) AND agent_status = 'idle' ORDER BY run_requested_at",[staleBefore]); return rows.map(rowToTask); }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<TaskRow>(
        'SELECT * FROM tasks WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const existing = rowToTask(rows[0]);
      const merged = { ...existing, ...updates };
      await client.query(
        `UPDATE tasks SET
          title = $1, description = $2, priority = $3, column_id = $4,
          agent_status = $5, agent_type = $6, started_at = $7, completed_at = $8,
          repo_path = $9, branch_name = $10, base_branch = $11, use_worktree = $12,
          worktree_path = $13, archived = $14, summary = $15, commit_sha = $16, run_requested_at=$17, run_claimed_at=$18,
          timeout_minutes=$19, pr_url=$20
        WHERE id = $21`,
        [
          merged.title,
          merged.description,
          merged.priority,
          merged.columnId,
          merged.agentStatus,
          merged.agentType,
          merged.startedAt ?? null,
          merged.completedAt ?? null,
          merged.repoPath ?? null,
          merged.branchName ?? null,
          merged.baseBranch ?? null,
          merged.useWorktree ?? null,
          merged.worktreePath ?? null,
          merged.archived ?? false,
          merged.summary ?? null, merged.commitSha ?? null, merged.runRequestedAt ?? null, merged.runClaimedAt ?? null, merged.timeoutMinutes ?? null, merged.prUrl ?? null,
          id,
        ]
      );
      await client.query('COMMIT');
      return merged;
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ cnt: string }>(
      'SELECT COUNT(*) as cnt FROM tasks'
    );
    return Number(rows[0].cnt);
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO events (id, task_id, type, content, timestamp, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.id,
        event.taskId,
        event.type,
        event.content,
        event.timestamp,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ]
    );
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    const { rows } = await this.pool.query<{
      id: string;
      task_id: string;
      type: string;
      content: string;
      timestamp: string;
      metadata: string | null;
    }>(
      'SELECT * FROM events WHERE task_id = $1 ORDER BY timestamp ASC',
      [taskId]
    );
    return rows.map((row) => {
      let metadata: AgentEvent['metadata'] | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch (err: unknown) {
          // Log malformed metadata
          console.warn(`[postgres] Failed to parse metadata for event ${row.id}:`, errorMessage(err));
        }
      }
      return {
        id: row.id,
        taskId: row.task_id,
        type: row.type as AgentEvent['type'],
        content: row.content,
        timestamp: Number(row.timestamp),
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async deleteEventsByTaskId(taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM events WHERE task_id = $1', [taskId]);
  }

  async getArchivedTasks(projectId = 'default'): Promise<Task[]> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE project_id = $1 AND archived = TRUE ORDER BY created_at DESC',
      [projectId],
    );
    return rows.map(rowToTask);
  }

  async beginRevision(input: BeginTaskRevisionInput): Promise<{ task: Task; revision: TaskRevision } | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: taskRows } = await client.query<TaskRow>(
        'SELECT * FROM tasks WHERE id = $1 FOR UPDATE',
        [input.taskId],
      );
      const taskRow = taskRows[0];
      if (!taskRow || taskRow.column_id !== 'review') {
        await client.query('ROLLBACK');
        return undefined;
      }

      const { rows: numberRows } = await client.query<{ revision_number: number }>(
        'SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number FROM task_revisions WHERE task_id = $1',
        [input.taskId],
      );
      const revisionNumber = Number(numberRows[0].revision_number);
      const { rows: revisionRows } = await client.query<TaskRevisionRow>(`
        INSERT INTO task_revisions (
          id, task_id, revision_number, feedback, status, created_at,
          started_at, completed_at, previous_summary, agent_summary, commit_sha,
          push_status, pushed_at, released_by_revision_id
        ) VALUES ($1, $2, $3, $4, 'pending', $5, NULL, NULL, $6, NULL, NULL, 'local', NULL, NULL)
        RETURNING *
      `, [input.id, input.taskId, revisionNumber, input.feedback, input.createdAt, taskRow.summary]);
      const { rows: updatedTaskRows } = await client.query<TaskRow>(`
        UPDATE tasks SET
          column_id = 'in-progress', agent_status = 'planning',
          started_at = $1, completed_at = NULL,
          run_requested_at = $1, run_claimed_at = NULL
        WHERE id = $2
        RETURNING *
      `, [input.createdAt, input.taskId]);
      await client.query('COMMIT');
      return { task: rowToTask(updatedTaskRows[0]), revision: rowToRevision(revisionRows[0]) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getRevisionsByTaskId(taskId: string): Promise<TaskRevision[]> {
    const { rows } = await this.pool.query<TaskRevisionRow>(`
      SELECT * FROM task_revisions
      WHERE task_id = $1
      ORDER BY revision_number ASC, created_at ASC, id ASC
    `, [taskId]);
    return rows.map(rowToRevision);
  }

  async getActiveRevisionByTaskId(taskId: string): Promise<TaskRevision | undefined> {
    const { rows } = await this.pool.query<TaskRevisionRow>(`
      SELECT * FROM task_revisions
      WHERE task_id = $1 AND status IN ('pending', 'in-progress')
      ORDER BY revision_number DESC
      LIMIT 1
    `, [taskId]);
    return rows[0] ? rowToRevision(rows[0]) : undefined;
  }

  async hasHeldRevisions(taskId: string): Promise<boolean> {
    const { rows } = await this.pool.query(`
      SELECT 1 FROM task_revisions
      WHERE task_id = $1 AND push_status = 'held'
      LIMIT 1
    `, [taskId]);
    return rows.length > 0;
  }

  async updateRevision(id: string, updates: TaskRevisionUpdates): Promise<TaskRevision | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<TaskRevisionRow>(
        'SELECT * FROM task_revisions WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const existing = rowToRevision(rows[0]);
      const merged = { ...existing, ...updates };
      const { rows: updatedRows } = await client.query<TaskRevisionRow>(`
        UPDATE task_revisions SET
          status = $1, started_at = $2, completed_at = $3,
          agent_summary = $4, commit_sha = $5, push_status = $6,
          pushed_at = $7, released_by_revision_id = $8
        WHERE id = $9
        RETURNING *
      `, [
        merged.status,
        merged.startedAt ?? null,
        merged.completedAt ?? null,
        merged.agentSummary ?? null,
        merged.commitSha ?? null,
        merged.pushStatus,
        merged.pushedAt ?? null,
        merged.releasedByRevisionId ?? null,
        id,
      ]);
      await client.query('COMMIT');
      return rowToRevision(updatedRows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async finalizeRevision(id: string, input: FinalizeTaskRevisionInput): Promise<TaskRevision | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<TaskRevisionRow>(
        'SELECT * FROM task_revisions WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if (input.releaseHeldRevisions) {
        await client.query(`
          UPDATE task_revisions SET
            push_status = 'released', pushed_at = $1, released_by_revision_id = $2
          WHERE task_id = $3 AND id <> $2 AND push_status = 'held'
        `, [input.pushedAt ?? input.completedAt, id, row.task_id]);
        await client.query(`
          UPDATE task_revisions SET push_status = 'pushed', pushed_at = $1
          WHERE task_id = $2 AND id <> $3 AND push_status = 'local' AND commit_sha IS NOT NULL
        `, [input.pushedAt ?? input.completedAt, row.task_id, id]);
      }
      const { rows: updatedRows } = await client.query<TaskRevisionRow>(`
        UPDATE task_revisions SET
          status = $1, completed_at = $2, agent_summary = $3, commit_sha = $4,
          push_status = $5, pushed_at = $6, released_by_revision_id = NULL
        WHERE id = $7
        RETURNING *
      `, [
        input.status,
        input.completedAt,
        input.agentSummary,
        input.commitSha,
        input.pushStatus,
        input.pushedAt ?? null,
        id,
      ]);
      await client.query('COMMIT');
      return rowToRevision(updatedRows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
