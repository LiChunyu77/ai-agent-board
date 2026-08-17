import type { Task, AgentEvent, TaskRevision, TaskRevisionPushStatus } from '../types.js';

export interface BeginTaskRevisionInput {
  id: string;
  taskId: string;
  feedback: string;
  createdAt: number;
}

export type TaskRevisionUpdates = Partial<Pick<
  TaskRevision,
  'status' | 'startedAt' | 'completedAt' | 'agentSummary' | 'commitSha' | 'pushStatus' | 'pushedAt' | 'releasedByRevisionId'
>>;

export interface FinalizeTaskRevisionInput {
  status: 'complete' | 'failed';
  completedAt: number;
  agentSummary: string | null;
  commitSha: string | null;
  pushStatus: TaskRevisionPushStatus;
  pushedAt?: number;
  /** Release every earlier held revision atomically with this finalization. */
  releaseHeldRevisions: boolean;
}

export interface TaskRepository {
  getAll(includeArchived?: boolean, projectId?: string): Promise<Task[]>;
  getById(id: string): Promise<Task | undefined>;
  getByExternalIdentity(source: string, key: string): Promise<Task | undefined>;
  create(task: Task): Promise<Task>;
  createIdempotent(task: Task): Promise<{ task: Task; created: boolean }>;
  requestRun(id: string, requestedAt: number): Promise<Task | undefined>;
  claimRun(id: string, claimedAt: number): Promise<Task | undefined>;
  clearRun(id: string): Promise<Task | undefined>;
  getPendingRuns(staleBefore?: number): Promise<Task[]>;
  update(id: string, updates: Partial<Task>): Promise<Task | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  insertEvent(event: AgentEvent): Promise<void>;
  getEventsByTaskId(taskId: string): Promise<AgentEvent[]>;
  deleteEventsByTaskId(taskId: string): Promise<void>;
  getArchivedTasks(projectId?: string): Promise<Task[]>;
  /** Atomically append a feedback round and return the task to durable planning state. */
  beginRevision(input: BeginTaskRevisionInput): Promise<{ task: Task; revision: TaskRevision } | undefined>;
  getRevisionsByTaskId(taskId: string): Promise<TaskRevision[]>;
  getActiveRevisionByTaskId(taskId: string): Promise<TaskRevision | undefined>;
  hasHeldRevisions(taskId: string): Promise<boolean>;
  updateRevision(id: string, updates: TaskRevisionUpdates): Promise<TaskRevision | undefined>;
  finalizeRevision(id: string, input: FinalizeTaskRevisionInput): Promise<TaskRevision | undefined>;
}
