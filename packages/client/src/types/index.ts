// Re-export all types and constants from the shared module
export type {
  Priority,
  ColumnId,
  AgentStatus,
  AgentType,
  AgentInfo,
  Project,
  ProjectTaskCounts,
  ProjectConfig,
  ProjectPathValidation,
  CreateProjectRequest,
  UpdateProjectRequest,
  Task,
  TaskAttachment,
  TaskRevision,
  TaskRevisionStatus,
  TaskRevisionPushStatus,
  RequestChangesResponse,
  TaskGroup,
  TaskTemplate,
  AgentEventType,
  AgentEvent,
  Column,
  WSMessage,
} from '../../../../shared/types.js';

export { VALID_TRANSITIONS, MAX_GROUP_CHILDREN, MIN_GROUP_CHILDREN } from '../../../../shared/constants.js';
