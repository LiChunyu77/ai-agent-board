import { v4 as uuid } from 'uuid';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Task, TaskGroup, AgentEvent, AgentType } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentProvider, AgentSession, AgentInfo, AgentAttachment } from '@codewithdan/agent-sdk-core';
import type { AgentEvent as CoreAgentEvent } from '@codewithdan/agent-sdk-core';
import { CopilotProvider, ClaudeProvider, CodexProvider, OpenCodeProvider, HermesProvider, OpenClawProvider, GrokProvider } from '@codewithdan/agent-sdk-core';
import { broadcast } from '../websocket.js';
import { UPLOADS_DIR } from '../routes/attachments.js';
import type { AttachmentStore } from '../repositories/attachment-types.js';
import { errorMessage } from '../utils.js';
import { detectAvailableAgents } from './agent-detection.js';
import { resolveTaskTimeoutMs } from './agent-timeout.js';

function loadAttachmentAsBase64(filePath: string, displayName: string, mimeType: string): AgentAttachment | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[agent-manager] attachment file not found: ${filePath}`);
      return null;
    }
    const fileBuffer = fs.readFileSync(filePath);
    const data = fileBuffer.toString('base64');
    console.log(`[agent-manager] loaded attachment: ${displayName} (${mimeType}, ${fileBuffer.length} bytes, base64 length: ${data.length})`);
    return { type: 'base64_image', data, displayName, mediaType: mimeType };
  } catch (err) {
    console.error(`[agent-manager] failed to load attachment ${filePath}:`, err);
    return null;
  }
}

interface ManagedSession {
  session?: AgentSession;
  timeoutId?: ReturnType<typeof setTimeout>;
  startTime: number;
  agentType: AgentType;
  revisionId?: string;
  onComplete?: AgentRunOptions['onComplete'];
  onPersistenceFailure?: AgentRunOptions['onPersistenceFailure'];
  completionSent?: boolean;
}

export interface AgentRevisionContext {
  /** Durable revision row identifier owned by the repository layer. */
  revisionId: string;
  feedback: string;
  /** Snapshot from the immediately preceding execution round. */
  previousSummary?: string | null;
  /** Only its presence authorizes updating the existing PR branch. */
  prUrl?: string;
  /** Durable unresolved hold from any earlier revision on this task branch. */
  hasHeldRevisions?: boolean;
}

export interface AgentRunCompletion {
  revisionId?: string;
  status: 'complete' | 'failed';
  agentSummary: string | null;
  commitSha?: string;
  /** True only when the completed revision commit is confirmed on origin/<task branch>. */
  pushed: boolean;
  error?: string;
}

interface GitRunResult {
  endHeadSha: string;
  commitSha?: string;
  noChanges: boolean;
}

export interface AgentRunOptions {
  revision?: AgentRevisionContext;
  onComplete?: (completion: AgentRunCompletion) => void | Promise<void>;
  onPersistenceFailure?: (error: string) => void | Promise<void>;
}

// Event log per task (capped to prevent unbounded growth)
const MAX_EVENTS_PER_TASK = 2000;
const MAX_EVENT_LOG_TASKS = 200;

// Deleted-task guard TTL
const DELETED_TASK_TTL_MS = 60_000;

const STREAM_BUFFER_FLUSH_MS = 40;
const STOPPED_TASK_TTL_MS = 30_000;

// Upper bound on accumulated assistant prose kept for summary extraction.
// We only need the tail (the final <task-summary> block), so cap memory use.
const MAX_SUMMARY_BUFFER = 64_000;
const MAX_REVISION_FEEDBACK_PROMPT_LENGTH = 20_000;
const MAX_PREVIOUS_SUMMARY_PROMPT_LENGTH = 20_000;

function safePromptText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .slice(0, maxLength)
    .trim();
}

type RevisionOperation = 'push' | 'merge' | 'commit';

function feedbackProhibitsOperation(feedback: string, operation: RevisionOperation): boolean {
  if (operation === 'push') {
    const chinesePush = /(?:(?:不要再|先不要|暂(?:时)?不|不要|不得|禁止|不允许|不能|不可|不可以|不需要|无需|无须|不必|不用|别再|别|切勿|严禁|未授权|没有授权|未经授权)\s*[^。！？\n]{0,20}|不\s*)(?:(?:git\s+)?push|推送|上传(?:到|至)?远程|提交(?:到|至)远程)/i;
    const chineseKeepLocal = /(?:先|暂时|暂且)?\s*(?:保留|留|保存)\s*[^。！？\n]{0,12}(?:在|到)?\s*本地|(?:只|仅)\s*(?:保留|留|保存|提交)\s*[^。！？\n]{0,12}(?:在|到)?\s*本地/i;
    const englishPush = /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|shouldn't|cannot|can't|cant|no|not\s+allowed\s+to|not\s+authorized\s+to|not\s+permitted\s+to|refrain\s+from)\b[^.!?\n]{0,40}\b(?:git\s+)?push(?:ing)?\b/i;
    const englishRemote = /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|shouldn't|cannot|can't|cant|no)\b[^.!?\n]{0,40}\b(?:upload|publish|send)\b[^.!?\n]{0,24}\bremote\b/i;
    const englishKeepLocal = /\b(?:keep|leave|remain|stay|store)\b[^.!?\n]{0,24}\b(?:changes?\s+)?local(?:ly)?\b/i;
    return chinesePush.test(feedback)
      || chineseKeepLocal.test(feedback)
      || englishPush.test(feedback)
      || englishRemote.test(feedback)
      || englishKeepLocal.test(feedback);
  }

  const englishOperation = operation === 'merge' ? 'merg(?:e|ing)' : 'commit(?:ting)?';
  const chineseOperation = operation === 'merge'
    ? '(?:git\\s+)?merge|合并'
    // "提交到远程" is a push prohibition, not a local commit prohibition.
    : '(?:git\\s+)?commit|提交(?![^。！？\\n]{0,8}(?:到|至)远程)';
  const chinese = new RegExp(
    `(?:不要再|先不要|暂(?:时)?不|不要|不得|禁止|不允许|不能|不可|不可以|不需要|无需|无须|不必|不用|别再|别|切勿|严禁|未授权|没有授权|未经授权)[^。！？\\n]{0,16}(?:${chineseOperation})`,
    'i',
  );
  const english = new RegExp(
    `\\b(?:do\\s+not|don't|dont|never|must\\s+not|should\\s+not|shouldn't|cannot|can't|cant|no|not\\s+allowed\\s+to|not\\s+authorized\\s+to|not\\s+permitted\\s+to|refrain\\s+from)\\b[^.!?\\n]{0,32}\\b(?:git\\s+)?${englishOperation}\\b`,
    'i',
  );
  return chinese.test(feedback) || english.test(feedback);
}

function feedbackAuthorizesMerge(feedback: string): boolean {
  if (feedbackProhibitsOperation(feedback, 'merge')) return false;
  return /(?:请\s*(?:执行|运行|进行)?|明确\s*(?:允许|授权)\s*(?:执行|运行|进行)?)\s*(?:git\s+)?merge/i.test(feedback)
    || /\b(?:please\s+(?:run\s+|execute\s+)?(?:git\s+)?merge|(?:i\s+)?explicitly\s+(?:allow|authorize)(?:\s+you)?\s+to\s+(?:run\s+|execute\s+)?(?:git\s+)?merge|you\s+are\s+explicitly\s+authorized\s+to\s+(?:run\s+|execute\s+)?(?:git\s+)?merge)\b/i.test(feedback);
}

export type RevisionPushIntent = 'prohibit' | 'authorize' | 'unspecified';

export interface RevisionPushPermission {
  allowed: boolean;
  remote: 'origin';
  branchName?: string;
  reason: 'explicitly-prohibited' | 'explicitly-authorized' | 'missing-existing-pr' | 'unspecified';
}

/** Parse only high-confidence current-round push permission; prohibition always wins. */
export function resolveRevisionPushIntent(feedback: string): RevisionPushIntent {
  if (feedbackProhibitsOperation(feedback, 'push')) return 'prohibit';
  const chineseAuthorization = /(?:可以|请|允许|授权|明确\s*(?:允许|授权))[^。！？\n]{0,20}(?:git\s+)?push/i.test(feedback)
    || /推送到[^。！？\n]{0,16}(?:现有|已有|原有|当前)?\s*(?:的)?\s*(?:PR|pull request)/i.test(feedback)
    || /(?:之前|此前|前面|历史)[^。！？\n]{0,20}(?:一起|一并)[^。！？\n]{0,12}(?:git\s+)?push/i.test(feedback);
  const englishAuthorization = /\b(?:please|may|you\s+(?:can|may)|explicitly\s+(?:allow|authorize)(?:\s+you)?\s+to)\b[^.!?\n]{0,24}\b(?:git\s+)?push\b/i.test(feedback)
    || /\bpush\b[^.!?\n]{0,24}\b(?:existing|current|same)\s+(?:PR|pull request)\b/i.test(feedback)
    || /\bpush\b[^.!?\n]{0,32}\b(?:including|together with|all)?\b[^.!?\n]{0,24}\b(?:previous|earlier|held)\b/i.test(feedback);
  return chineseAuthorization || englishAuthorization ? 'authorize' : 'unspecified';
}

/** Resolve the execution permission. Revision pushes are denied unless every allow condition is explicit. */
export function resolveRevisionPushPermission(task: Task, revision?: AgentRevisionContext): RevisionPushPermission {
  if (!revision) return { allowed: false, remote: 'origin', reason: 'unspecified' };
  const intent = resolveRevisionPushIntent(revision.feedback);
  if (intent === 'prohibit') {
    return { allowed: false, remote: 'origin', branchName: task.branchName, reason: 'explicitly-prohibited' };
  }
  if (intent !== 'authorize') {
    return { allowed: false, remote: 'origin', branchName: task.branchName, reason: 'unspecified' };
  }
  if (!revision.prUrl || !task.branchName) {
    return { allowed: false, remote: 'origin', branchName: task.branchName, reason: 'missing-existing-pr' };
  }
  return { allowed: true, remote: 'origin', branchName: task.branchName, reason: 'explicitly-authorized' };
}

export interface RevisionToolUseInput {
  toolName?: unknown;
  toolArgs?: unknown;
  [key: string]: unknown;
}

export interface RevisionToolUseDecision {
  permissionDecision?: 'allow' | 'deny';
  permissionDecisionReason?: string;
  operation?: 'push' | 'force-push' | 'remote-mutation';
}

const SHELL_TOOL_NAMES = /(?:^|[_-])(?:bash|shell|execute|command|terminal|run)(?:$|[_-])/i;

function readShellCommand(toolArgs: unknown): string | undefined {
  if (typeof toolArgs === 'string') return toolArgs;
  if (Array.isArray(toolArgs) && toolArgs.every((item) => typeof item === 'string')) {
    return toolArgs.join(' ');
  }
  if (!toolArgs || typeof toolArgs !== 'object') return undefined;
  const record = toolArgs as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script', 'shell_command', 'input']) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(' ');
  }
  return undefined;
}

function classifyRemoteMutation(command: string): RevisionToolUseDecision['operation'] | undefined {
  // Normalize harmless quoting around command words so `git "push"` cannot evade the boundary.
  const normalized = command.replace(/(["'])(git|push|send-pack|receive-pack)\1/gi, '$2');
  const gitPush = /\b(?:[\w./-]*\/)?git(?:\s+-[A-Za-z]\s+\S+)*\s+push\b/i;
  if (gitPush.test(normalized)) {
    return /(?:^|\s)(?:--force(?:-with-lease|-if-includes)?|-f)(?:\s|=|$)|(?:^|\s)\+\S+/i.test(normalized)
      ? 'force-push'
      : 'push';
  }
  if (/(?:^|\s)(?:[\w./-]*\/)?git\s+(?:send-pack|receive-pack)\b/i.test(normalized)) {
    return 'remote-mutation';
  }
  if (/(?:^|\s)gh\s+pr\s+merge\b/i.test(normalized)) return 'remote-mutation';
  if (/(?:^|\s)gh\s+api\b[^\n]*(?:\/git\/refs|\/git\/tags|\/merges)(?:\s|$)/i.test(normalized)
      && /(?:^|\s)(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b/i.test(normalized)) {
    return 'remote-mutation';
  }
  return undefined;
}

function isAuthorizedOrdinaryPush(command: string, permission: RevisionPushPermission): boolean {
  if (!permission.allowed || !permission.branchName) return false;
  const escapedBranch = permission.branchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^(?:[\\w./-]*/)?git\\s+push\\s+(?:(?:-u|--set-upstream)\\s+)?origin\\s+${escapedBranch}\\s*$`,
    'i',
  ).test(command.trim());
}

/**
 * Command-level revision push boundary shared by provider adapters. A denied
 * result is consumed by the SDK before the shell tool executes.
 */
export function evaluateRevisionToolUse(
  input: RevisionToolUseInput,
  permission: RevisionPushPermission,
): RevisionToolUseDecision {
  const toolName = typeof input.toolName === 'string' ? input.toolName : '';
  if (!SHELL_TOOL_NAMES.test(toolName)) return {};
  const command = readShellCommand(input.toolArgs);
  if (!command) return {};
  const operation = classifyRemoteMutation(command);
  if (!operation) return {};
  if (operation === 'push' && isAuthorizedOrdinaryPush(command, permission)) {
    return { permissionDecision: 'allow', operation };
  }
  const reason = operation === 'force-push'
    ? 'Force-push is not authorized for revision runs.'
    : operation === 'push'
      ? 'This revision is not authorized to push, or the push target is not the authorized origin branch.'
      : 'Equivalent remote Git mutations are not authorized for revision runs.';
  return { permissionDecision: 'deny', permissionDecisionReason: reason, operation };
}

/** Providers whose adapters expose a native, pre-execution command hook. */
export function providerSupportsRevisionToolGuard(agentType: AgentType): boolean {
  return agentType === 'copilot' || agentType === 'claude';
}

/** Build a fresh execution prompt; a revision never attempts to resume an old SDK session. */
export function buildAgentExecutionPrompt(task: Task, revision?: AgentRevisionContext): string {
  const title = safePromptText(task.title, 500);
  const description = safePromptText(task.description || '', 50_000);
  if (!revision) return `${title}\n\n${description}`;

  const feedback = safePromptText(revision.feedback, MAX_REVISION_FEEDBACK_PROMPT_LENGTH);
  const previousSummary = safePromptText(
    revision.previousSummary || 'No previous execution summary is available.',
    MAX_PREVIOUS_SUMMARY_PROMPT_LENGTH,
  );
  const branchName = task.branchName ? safePromptText(task.branchName, 200) : '';
  const existingPr = Boolean(revision.prUrl && branchName);
  const pushIntent = resolveRevisionPushIntent(revision.feedback);
  const pushProhibited = pushIntent === 'prohibit';
  const pushAuthorized = pushIntent === 'authorize';
  const hasHeldRevisions = Boolean(revision.hasHeldRevisions);
  const mergeProhibited = feedbackProhibitsOperation(revision.feedback, 'merge');
  const commitProhibited = feedbackProhibitsOperation(revision.feedback, 'commit');
  const pushInstructions = pushProhibited
    ? 'The review feedback explicitly prohibits push. Do not run git push or otherwise update any remote branch.'
    : commitProhibited
      ? 'The review feedback prohibits commit, so this revision must also remain local. Do not push or otherwise update any remote branch.'
      : !existingPr
        ? 'No existing pull request is linked to this task. Do not push or create a pull request.'
        : !pushAuthorized
          ? hasHeldRevisions
            ? 'This task branch contains revisions whose push is still held. Complete and commit this revision locally, but do not run git push or update the remote branch. Explicit user authorization is required before any local or previously held commits may be published.'
            : 'Revision push permission is denied by default. Complete and commit this revision locally, but do not run git push or update the remote branch. Explicit user authorization is required before local commits may be published.'
          : hasHeldRevisions
            ? `The current review feedback explicitly authorizes releasing the existing push hold. After committing, push the complete task branch to the SAME existing pull request with \`git push origin ${branchName}\`, including the previously held revisions. Do not push any other branch.`
            : `The current review feedback explicitly authorizes an ordinary push to the SAME existing pull request after committing. Run only \`git push origin ${branchName}\`. Do not push any other branch.`;
  const mergeInstructions = mergeProhibited
    ? 'The review feedback explicitly prohibits merge. Do not run git merge or merge the pull request.'
    : feedbackAuthorizesMerge(revision.feedback)
      ? 'The review feedback explicitly authorizes merge. Perform only the specifically requested merge; do not broaden its scope.'
      : 'Merge is prohibited by default. Do not run git merge or merge the pull request.';
  const commitInstructions = commitProhibited
    ? 'The review feedback explicitly prohibits commit. Do not create a commit, and do not stage files solely for committing.'
    : 'If you changed files, review the diff and create a concise commit after tests pass.';

  return [
    'This is a NEW revision execution round. Do not attempt to resume or message the previous agent session.',
    'Instruction priority: explicit requirements and restrictions in the current review feedback are highest priority for this task. They override all default commit, push, merge, and file-editing behavior below. Never reinterpret a default as permission to violate the feedback.',
    '',
    '## Original task title',
    title,
    '',
    '## Original task description',
    description || '(No description provided.)',
    '',
    '## Review feedback for this round',
    feedback,
    '',
    '## Previous execution context',
    previousSummary,
    '',
    '## Default Git and pull request policy (subordinate to review feedback)',
    commitInstructions,
    pushInstructions,
    mergeInstructions,
    'Never force-push. Never edit a file that the review feedback explicitly says not to modify.',
  ].join('\n');
}

/** Validate the revision's final git state without overriding an explicit no-commit instruction. */
export function inspectRevisionCompletion(
  task: Task,
  workingDirectory: string,
  commitProhibited: boolean,
): string | undefined {
  if (!task.repoPath) return undefined;
  if (task.branchName) {
    assertSafeGitBranch(task.branchName, 'branchName');
    const currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: workingDirectory,
      stdio: 'pipe',
    }).toString().trim();
    if (currentBranch !== task.branchName) {
      throw new Error(`Revision finished on ${currentBranch || 'detached HEAD'} instead of ${task.branchName}`);
    }
  }
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: workingDirectory,
    stdio: 'pipe',
  }).toString().trim();
  if (dirty) throw new Error('Revision finished with uncommitted changes; the worktree was preserved for attention');
  if (commitProhibited) return undefined;
  const commitSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: workingDirectory,
    stdio: 'pipe',
  }).toString().trim();
  return /^[0-9a-f]{40,64}$/i.test(commitSha) ? commitSha : undefined;
}

function readGitHead(workingDirectory: string): string | undefined {
  try {
    const commitSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workingDirectory,
      stdio: 'pipe',
    }).toString().trim();
    return /^[0-9a-f]{40,64}$/i.test(commitSha) ? commitSha : undefined;
  } catch {
    return undefined;
  }
}

/** Prove that a successful provider run left either a new commit or an explicitly clean no-op. */
export function inspectRunCompletion(
  task: Task,
  workingDirectory: string,
  startHeadSha: string | undefined,
): GitRunResult {
  if (task.branchName) {
    assertSafeGitBranch(task.branchName, 'branchName');
    const currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: workingDirectory,
      stdio: 'pipe',
    }).toString().trim();
    if (currentBranch !== task.branchName) {
      throw new Error(`Task finished on ${currentBranch || 'detached HEAD'} instead of ${task.branchName}`);
    }
  }
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: workingDirectory,
    stdio: 'pipe',
  }).toString().trim();
  if (dirty) {
    throw new Error('Task finished with uncommitted changes; commit failed or was not created. The worktree was preserved for attention');
  }
  const commitSha = readGitHead(workingDirectory);
  if (!commitSha) throw new Error('Task finished without a persistent Git commit');
  if (commitSha === startHeadSha) return { endHeadSha: commitSha, noChanges: true };
  if (startHeadSha) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', startHeadSha, commitSha], {
        cwd: workingDirectory,
        stdio: 'pipe',
      });
    } catch {
      throw new Error('Task branch history was rewritten instead of advanced; the worktree was preserved for attention');
    }
  }
  return { endHeadSha: commitSha, commitSha, noChanges: false };
}

/** Read-only confirmation that a revision commit is included in origin/<task branch>. */
export function isRevisionCommitOnRemote(
  task: Task,
  workingDirectory: string,
  commitSha: string | undefined,
): boolean {
  if (!commitSha || !task.branchName) return false;
  assertSafeGitBranch(task.branchName, 'branchName');
  const remoteRef = `refs/remotes/origin/${task.branchName}`;
  try {
    execFileSync('git', ['rev-parse', '--verify', remoteRef], { cwd: workingDirectory, stdio: 'pipe' });
    execFileSync('git', ['merge-base', '--is-ancestor', commitSha, remoteRef], {
      cwd: workingDirectory,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function buildAgentSystemPrompt(
  task: Task,
  workingDirectory: string,
  worktreePath: string | undefined,
  hasGit: boolean,
): string {
  const safeTitle = task.title.replace(/[<>]/g, '');
  return `
<context>
You are a coding agent working on a task in the project directory: ${workingDirectory}
Task: ${safeTitle}
${worktreePath ? `\nIMPORTANT: All file paths MUST be under ${worktreePath}. Do NOT reference or edit files at ${task.repoPath} directly.` : ''}
${!hasGit ? `\nIMPORTANT: This directory is not a git repository. Run \`git init\` first before making any changes, so all work is tracked.` : ''}
Complete the task described in the user prompt. Be thorough — read relevant files,
make precise edits, and verify your changes compile/pass tests when applicable.

Permission priority:
- Explicit instructions and restrictions in the current user prompt or review feedback are authoritative for this task and override the defaults below.
- If the user prohibits commit, push, merge, or editing a file, obey that prohibition.

Before you finish the task:
- If you changed any tracked or untracked project files, review them with git status and git diff.
- Unless the current user prompt or review feedback prohibits commits, git add and git commit intentional completed changes on the current task branch.
- Use a concise commit message when a commit is permitted.
- Do not push unless the current revision prompt conditionally permits updating an existing pull request and the current user/review feedback does not prohibit push.
- An unresolved push hold from an earlier revision overrides the default existing-PR push policy until the user explicitly releases it.
- Do not merge unless the current user/review feedback explicitly authorizes that merge. Never force-push.
- If no files were changed, do not create an empty commit.

When you have finished, end your VERY LAST message with a task summary in EXACTLY this format (keep the tags on their own lines):
<task-summary>
## Completed
A clear description of what you accomplished. This section is required and must not be empty.
## Comments
Optional notes, caveats, decisions, or context. Omit the body if there is nothing to add.
## Remaining
Optional list of any work you did not complete or that should be followed up. Omit the body if everything is done.
</task-summary>
</context>
`;
}

/**
 * Extract the agent-authored task summary from accumulated assistant prose.
 * Returns the trimmed contents of the LAST `<task-summary>…</task-summary>`
 * block, or null when no usable block is present.
 */
function extractTaskSummary(buffer: string): string | null {
  if (!buffer) return null;
  const closed = [...buffer.matchAll(/<task-summary>([\s\S]*?)<\/task-summary>/g)];
  if (closed.length > 0) {
    const body = closed[closed.length - 1][1].trim();
    return body.length > 0 ? body : null;
  }
  // Tolerate a missing closing tag: take everything after the last opening tag.
  const openIdx = buffer.lastIndexOf('<task-summary>');
  if (openIdx >= 0) {
    const body = buffer.slice(openIdx + '<task-summary>'.length).replace(/<\/task-summary>/g, '').trim();
    return body.length > 0 ? body : null;
  }
  return null;
}

function getErrorStderr(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    const stderr = (err as Error & { stderr?: Buffer | string }).stderr;
    return stderr?.toString() ?? '';
  }
  return '';
}

function canonicalPath(candidate: string): string {
  const resolved = fs.realpathSync(candidate);
  const parsed = path.parse(resolved);
  const normalized = resolved === parsed.root
    ? path.normalize(resolved)
    : path.normalize(resolved).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertSafeGitBranch(branchName: string, label: string): void {
  if (!branchName || /[\u0000-\u001F\u007F]/.test(branchName)) {
    throw new Error(`${label} is invalid`);
  }
  try {
    execFileSync('git', ['check-ref-format', '--branch', branchName], { stdio: 'pipe' });
  } catch {
    throw new Error(`${label} is not a valid git branch name`);
  }
}

interface GroupQueue {
  groupId: string;
  maxConcurrency: number;
  pendingTaskIds: string[];
  runningTaskIds: Set<string>;
  completedTaskIds: Set<string>;
  failedTaskIds: Set<string>;
  tasks: Map<string, Task>;
  makeStatusCallback: (task: Task) => (status: Task['agentStatus']) => void | Promise<void>;
  makeWorktreeCallback: (task: Task) => (worktreePath: string) => void | Promise<void>;
  onChildComplete: (taskId: string) => void | Promise<void>;
}

export class AgentManager {
  private providers = new Map<AgentType, AgentProvider>();
  private sessions = new Map<string, ManagedSession>();
  private deletedTasks = new Set<string>();
  /** Tasks stopped by user — prevents duplicate agent_complete from terminateOnce */
  private stoppedTasks = new Set<string>();
  private eventLogs = new Map<string, AgentEvent[]>();
  private eventRepo: TaskRepository | null = null;
  private attachmentStore: AttachmentStore | null = null;
  private availableAgents: AgentInfo[] = [];
  /** Pending coalesced output/thinking broadcast per task */
  private streamBuffer = new Map<string, { event: AgentEvent; timer: ReturnType<typeof setTimeout> }>();
  private groupQueues = new Map<string, GroupQueue>();
  /** Per-repo mutex to serialize git operations (merge, checkout) */
  private repoLocks = new Map<string, Promise<void>>();

  /** Call once at startup to enable event persistence. */
  initEventPersistence(repo: TaskRepository): void {
    this.eventRepo = repo;
  }

  initAttachmentStore(store: AttachmentStore): void {
    this.attachmentStore = store;
  }

  /** Detect available agents, register providers, start the ones that are available. */
  async initialize(): Promise<void> {
    // Register all providers
    this.providers.set('copilot', new CopilotProvider());
    this.providers.set('claude', new ClaudeProvider({ permissionMode: 'bypassPermissions' }));
    this.providers.set('codex', new CodexProvider());
    this.providers.set('opencode', new OpenCodeProvider());
    this.providers.set('hermes', new HermesProvider());
    this.providers.set('openclaw', new OpenClawProvider());
    this.providers.set('grok', new GrokProvider());

    // Detect which agents are actually available on this system
    this.availableAgents = await detectAvailableAgents();
    const available = this.availableAgents.filter(a => a.available);

    console.log(
      `[agent-manager] detected agents: ${this.availableAgents.map(a => `${a.displayName}=${a.available ? 'yes' : 'no'}`).join(', ')}`
    );

    // In test/CI environments there are no real agent credentials, and some
    // provider SDKs spawn a background session on start() that rejects (e.g.
    // Copilot without GitHub auth) as a detached unhandled rejection — which
    // would crash the server. When startup is disabled we skip booting real SDK
    // clients. Because no provider is started, no agent can actually run, so we
    // also report every detected agent as unavailable. This keeps the agents
    // listed in the UI (as "Unavailable") while ensuring real-execution E2E
    // specs skip instead of attempting sessions that would hang or fail — a CLI
    // shim on PATH (e.g. node_modules/.bin/copilot) otherwise makes detection
    // report an agent that cannot be used here as "available".
    const skipAgentStartup =
      process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === '1' ||
      process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === 'true';
    if (skipAgentStartup) {
      console.log('[agent-manager] AGENTBOARD_DISABLE_AGENT_STARTUP set — skipping provider start()');
      this.availableAgents = this.availableAgents.map(a => ({
        ...a,
        available: false,
        reason: 'Agent startup disabled (test environment)',
      }));
      return;
    }

    // Start available providers
    for (const info of available) {
      const provider = this.providers.get(info.name);
      if (provider) {
        try {
          await provider.start();
        } catch (err: unknown) {
          console.error(`[agent-manager] failed to start ${info.displayName}: ${errorMessage(err)}`);
          // Mark as unavailable
          const agentInfo = this.availableAgents.find(a => a.name === info.name);
          if (agentInfo) {
            agentInfo.available = false;
            agentInfo.reason = `Failed to start: ${errorMessage(err)}`;
          }
        }
      }
    }
  }

  async refresh(): Promise<AgentInfo[]> {
    const detected = await detectAvailableAgents();
    for (const info of detected) {
      const provider = this.providers.get(info.name);
      if (!info.available || !provider) continue;
      const wasAvailable = this.availableAgents.find((item) => item.name === info.name)?.available;
      if (wasAvailable) continue;
      try {
        await provider.start();
      } catch (err: unknown) {
        info.available = false;
        info.reason = `Failed to start: ${errorMessage(err)}`;
      }
    }
    this.availableAgents = detected;
    return this.getAvailableAgents();
  }

  getAvailableAgents(): AgentInfo[] {
    return [...this.availableAgents];
  }

  // ─── Event Management (moved from copilot.ts) ─────────────────────

  private emitEvent(taskId: string, event: AgentEvent): void {
    if (this.deletedTasks.has(taskId)) return;
    // Drop empty content events — nothing to show
    if (!event.content?.trim() && event.type !== 'complete' && event.type !== 'error') return;

    let log = this.eventLogs.get(taskId) || [];
    log.push(event);
    if (log.length > MAX_EVENTS_PER_TASK) {
      log = log.slice(-MAX_EVENTS_PER_TASK);
    }
    // LRU touch
    this.eventLogs.delete(taskId);
    this.eventLogs.set(taskId, log);
    if (this.eventLogs.size > MAX_EVENT_LOG_TASKS) {
      const oldest = this.eventLogs.keys().next().value;
      if (oldest) this.eventLogs.delete(oldest);
    }
    // Write-through to database
    if (this.eventRepo) {
      this.eventRepo.insertEvent(event).catch((err: unknown) => {
        console.error(`[agent-manager] failed to persist event: ${errorMessage(err)}`);
      });
    }
    const STREAMABLE = new Set(['output', 'thinking']);

    const flushBuffer = (taskId: string) => {
      const buf = this.streamBuffer.get(taskId);
      if (buf) {
        clearTimeout(buf.timer);
        broadcast({ type: 'agent_event', payload: buf.event });
        this.streamBuffer.delete(taskId);
      }
    };

    if (STREAMABLE.has(event.type)) {
      const existing = this.streamBuffer.get(event.taskId);
      if (existing && existing.event.type === event.type) {
        // Same type — merge content and reset timer
        clearTimeout(existing.timer);
        existing.event.content += event.content;
        existing.timer = setTimeout(() => flushBuffer(event.taskId), STREAM_BUFFER_FLUSH_MS);
      } else {
        // Different type or no buffer — flush existing, start new buffer
        if (existing) flushBuffer(event.taskId);
        const timer = setTimeout(() => flushBuffer(event.taskId), STREAM_BUFFER_FLUSH_MS);
        this.streamBuffer.set(event.taskId, { event: { ...event }, timer });
      }
    } else {
      // Non-streamable: flush pending buffer first, then broadcast immediately
      flushBuffer(event.taskId);
      broadcast({ type: 'agent_event', payload: event });
    }
  }

  async getEvents(taskId: string): Promise<AgentEvent[]> {
    // Prefer DB (complete, ordered) over in-memory (capped, may be partial)
    if (this.eventRepo) {
      const dbEvents = await this.eventRepo.getEventsByTaskId(taskId);
      if (dbEvents.length > 0) return dbEvents;
    }
    // Fall back to in-memory (task still running, not yet persisted)
    const memEvents = this.eventLogs.get(taskId);
    if (memEvents && memEvents.length > 0) {
      this.eventLogs.delete(taskId);
      this.eventLogs.set(taskId, memEvents);
      return [...memEvents];
    }
    return [];
  }

  clearEvents(taskId: string): void {
    this.deletedTasks.add(taskId);
    setTimeout(() => this.deletedTasks.delete(taskId), DELETED_TASK_TTL_MS);
    this.resetEvents(taskId);
  }

  /** Clear stored events for a task without suppressing future events (used on re-run) */
  resetEvents(taskId: string): void {
    this.eventLogs.delete(taskId);
    if (this.eventRepo) {
      this.eventRepo.deleteEventsByTaskId(taskId).catch((err: unknown) => {
        console.error(`[agent-manager] failed to delete persisted events: ${errorMessage(err)}`);
      });
    }
  }

  // ─── Worktree Management (moved from copilot.ts) ──────────────────

  private assertTaskRepository(task: Task): void {
    if (!task.repoPath || !path.isAbsolute(task.repoPath)) {
      throw new Error('Worktree tasks require an absolute repoPath');
    }
    let topLevel: string;
    try {
      if (!fs.statSync(task.repoPath).isDirectory()) throw new Error('not a directory');
      topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: task.repoPath,
        stdio: 'pipe',
      }).toString().trim();
    } catch {
      throw new Error('Task repoPath must be an existing git repository');
    }
    if (canonicalPath(topLevel) !== canonicalPath(task.repoPath)) {
      throw new Error('Task repoPath must be the git repository root');
    }
  }

  private refExists(repoPath: string, fullRef: string): boolean {
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', fullRef], {
        cwd: repoPath,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  private assertWorktreeBranch(worktreePath: string, branchName: string): void {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: worktreePath,
      stdio: 'pipe',
    }).toString().trim();
    const currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: worktreePath,
      stdio: 'pipe',
    }).toString().trim();
    if (canonicalPath(topLevel) !== canonicalPath(worktreePath) || currentBranch !== branchName) {
      throw new Error(`Worktree is not checked out on the expected task branch: ${branchName}`);
    }
  }

  // Returns true when `worktreePath` is registered with git as a worktree
  // checked out on `branchName`. Used to safely reuse a worktree left over
  // from a prior (e.g. failed) run instead of colliding on the branch.
  private worktreeRegisteredForBranch(repoPath: string, worktreePath: string, branchName: string): boolean {
    try {
      const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        stdio: 'pipe',
      }).toString();
      const target = canonicalPath(worktreePath);
      for (const block of out.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/);
        const wtLine = lines.find((l) => l.startsWith('worktree '));
        if (!wtLine) continue;
        if (canonicalPath(wtLine.slice('worktree '.length)) !== target) continue;
        return lines.includes(`branch refs/heads/${branchName}`);
      }
    } catch {
      /* fall through — treat as not reusable */
    }
    return false;
  }

  setupWorktree(task: Task): string | undefined {
    if (!task.useWorktree) return undefined;
    if (!task.repoPath) throw new Error('Worktree tasks require repoPath');
    if (!task.branchName) throw new Error('Worktree tasks require branchName');
    this.assertTaskRepository(task);
    assertSafeGitBranch(task.branchName, 'branchName');
    const baseBranch = task.baseBranch || 'main';
    assertSafeGitBranch(baseBranch, 'baseBranch');
    if (task.branchName === baseBranch) {
      throw new Error('Task branch must differ from its base branch');
    }

    // Reuse a valid worktree left over from a prior run (e.g. after a failed
    // attempt). Without this, a restart would mint a new temp dir and fail with
    // "branch already used by worktree", since the old worktree still holds the
    // branch — and any in-progress work in it would be stranded.
    if (
      task.worktreePath &&
      path.resolve(task.worktreePath) !== path.resolve(task.repoPath) &&
      fs.existsSync(task.worktreePath) &&
      this.worktreeRegisteredForBranch(task.repoPath, task.worktreePath, task.branchName)
    ) {
      this.assertWorktreeBranch(task.worktreePath, task.branchName);
      console.log(`[worktree] reusing existing ${task.worktreePath}`);
      return task.worktreePath;
    }

    // Clear stale worktree records (e.g. dirs deleted out from under git) so a
    // fresh add for this branch isn't blocked by a dangling registration.
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: task.repoPath, stdio: 'pipe' });
    } catch {
      /* best effort */
    }

    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), `agentboard-${task.id}-`));

    try {
      const localRef = `refs/heads/${task.branchName}`;
      const remoteRef = `refs/remotes/origin/${task.branchName}`;
      if (this.refExists(task.repoPath, localRef)) {
        execFileSync(
          'git', ['worktree', 'add', worktreePath, task.branchName],
          { cwd: task.repoPath, stdio: 'pipe' },
        );
        console.log(`[worktree] attached existing branch ${task.branchName} at ${worktreePath}`);
      } else if (this.refExists(task.repoPath, remoteRef)) {
        execFileSync(
          'git', ['worktree', 'add', '-b', task.branchName, worktreePath, `origin/${task.branchName}`],
          { cwd: task.repoPath, stdio: 'pipe' },
        );
        console.log(`[worktree] restored branch ${task.branchName} from origin at ${worktreePath}`);
      } else {
        execFileSync(
          'git', ['worktree', 'add', '-b', task.branchName, worktreePath, baseBranch],
          { cwd: task.repoPath, stdio: 'pipe' },
        );
        console.log(`[worktree] created at ${worktreePath} from ${baseBranch}`);
      }
      this.assertWorktreeBranch(worktreePath, task.branchName);
      return worktreePath;
    } catch (err: unknown) {
      try { fs.rmdirSync(worktreePath); } catch { /* only remove the empty directory we created */ }
      console.error(`[worktree] failed:`, errorMessage(err));
      throw new Error(`Failed to create worktree: ${errorMessage(err)}`);
    }
  }

  removeWorktree(task: Task): void {
    if (!task.worktreePath || !task.repoPath) return;
    if (!task.branchName) throw new Error('Task has no branch configured');
    this.assertTaskRepository(task);
    assertSafeGitBranch(task.branchName, 'branchName');
    if (!this.worktreeRegisteredForBranch(task.repoPath, task.worktreePath, task.branchName)) {
      throw new Error('Refusing to remove a path that is not the registered task worktree');
    }
    try {
      execFileSync('git', ['worktree', 'remove', task.worktreePath, '--force'], {
        cwd: task.repoPath,
        stdio: 'pipe',
      });
      console.log(`[worktree] removed ${task.worktreePath}`);
    } catch (err: unknown) {
      console.error(`[worktree] remove failed:`, errorMessage(err));
      throw new Error(`Failed to remove worktree: ${errorMessage(err)}`);
    }
  }

  /** Read-only discovery for PRs created before `prUrl` was persisted on tasks. */
  findOpenPullRequest(task: Task): string | undefined {
    if (!task.repoPath || !task.branchName) return undefined;
    try {
      this.assertTaskRepository(task);
      assertSafeGitBranch(task.branchName, 'branchName');
      const raw = execFileSync(
        'gh',
        ['pr', 'view', task.branchName, '--json', 'url,state'],
        {
          cwd: task.repoPath,
          stdio: 'pipe',
          timeout: 15_000,
          env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        },
      ).toString();
      const parsed = JSON.parse(raw) as { url?: unknown; state?: unknown };
      if (parsed.state !== 'OPEN' || typeof parsed.url !== 'string') return undefined;
      const url = new URL(parsed.url);
      if (url.protocol !== 'https:' || url.username || url.password) return undefined;
      return url.toString();
    } catch {
      // Legacy discovery is best-effort; absence/auth/network errors mean no push authorization.
      return undefined;
    }
  }

  createPR(task: Task): { url: string } {
    if (!task.repoPath || !task.branchName) {
      throw new Error('Task has no repo path or branch name configured');
    }
    this.assertTaskRepository(task);
    assertSafeGitBranch(task.branchName, 'branchName');
    const baseBranch = task.baseBranch || 'main';
    assertSafeGitBranch(baseBranch, 'baseBranch');
    const cwd = task.worktreePath || task.repoPath;

    // Check that a remote named 'origin' exists
    try {
      const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, stdio: 'pipe' }).toString().trim();
      if (!remoteUrl) throw new Error('empty');
    } catch {
      throw new Error(
        'No git remote "origin" configured. Push your repo to GitHub first:\n' +
        `  cd ${task.repoPath}\n` +
        '  gh repo create <name> --source=. --push'
      );
    }

    try {
      execFileSync('git', ['push', '-u', 'origin', task.branchName], { cwd, stdio: 'pipe' });
      const prTitle = task.title.replace(/[<>]/g, '').slice(0, 200);
      const result = execFileSync(
        'gh',
        ['pr', 'create', '--base', baseBranch, '--head', task.branchName,
         '--title', prTitle, '--body', `Automated PR from Kanban task ${task.id}`, '--'],
        { cwd, stdio: 'pipe' },
      );
      const url = result.toString().trim();
      console.log(`[pr] created: ${url}`);
      return { url };
    } catch (err: unknown) {
      const stderr = getErrorStderr(err);
      const msg = stderr || errorMessage(err);
      console.error(`[pr] creation failed:`, msg);
      throw new Error(`PR creation failed: ${msg.trim()}`);
    }
  }

  private async withRepoLock<T>(repoPath: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(repoPath) ?? Promise.resolve();
    let resolve: () => void;
    const lock = new Promise<void>((r) => { resolve = r; });
    this.repoLocks.set(repoPath, lock);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
      if (this.repoLocks.get(repoPath) === lock) this.repoLocks.delete(repoPath);
    }
  }

  async mergeLocal(task: Task): Promise<{ merged: true; baseBranch: string }> {
    if (!task.repoPath || !task.branchName) {
      throw new Error('Task has no repo path or branch name configured');
    }
    const repoPath = task.repoPath;
    const branchName = task.branchName;
    const baseBranch = task.baseBranch || 'main';

    return this.withRepoLock(repoPath, () => {
      try {
        execFileSync('git', ['checkout', baseBranch], { cwd: repoPath, stdio: 'pipe' });
        execFileSync('git', ['merge', branchName, '--no-edit'], { cwd: repoPath, stdio: 'pipe' });
        console.log(`[merge] merged ${branchName} into ${baseBranch}`);
        return { merged: true as const, baseBranch };
      } catch (err: unknown) {
        try { execFileSync('git', ['merge', '--abort'], { cwd: repoPath, stdio: 'pipe' }); } catch { /* already clean */ }
        const stderr = getErrorStderr(err);
        const msg = stderr || errorMessage(err);
        console.error(`[merge] failed:`, msg);
        throw new Error(`Merge failed (conflicts?). Branch ${branchName} was not merged:\n${msg.trim()}`);
      }
    });
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────

  private async notifyRunComplete(entry: ManagedSession, completion: AgentRunCompletion): Promise<void> {
    if (entry.completionSent) return;
    if (entry.onComplete) await entry.onComplete(completion);
    entry.completionSent = true;
  }

  startAgent(
    task: Task,
    onStatusChange: (status: Task['agentStatus']) => void | Promise<void>,
    onWorktreeCreated?: (worktreePath: string) => void | Promise<void>,
    options: AgentRunOptions = {},
  ): void {
    if (this.sessions.has(task.id)) return;

    const agentType = task.agentType || 'copilot';
    const sessionStartTime = Date.now();
    let terminated = false;
    let agentSummary: string | null = null;
    let commitSha: string | undefined;
    let pushed = false;
    const managedEntry: ManagedSession = {
      startTime: sessionStartTime,
      agentType,
      revisionId: options.revision?.revisionId,
      onComplete: options.onComplete,
      onPersistenceFailure: options.onPersistenceFailure,
    };
    // Install before availability checks so early failures complete a durable revision.
    this.sessions.set(task.id, managedEntry);

    // Clear prior result metadata before execution so a failed rerun cannot
    // present an older commit or summary as the current result.
    let resultResetPersisted = Promise.resolve();
    if (task.summary != null || task.commitSha != null) {
      resultResetPersisted = (async () => {
        if (!this.eventRepo) throw new Error('task repository is unavailable');
        const reset = await this.eventRepo.update(task.id, { summary: null, commitSha: null });
        if (!reset) throw new Error('prior task result could not be cleared');
      })();
    }
    const terminateOnce = async (requestedStatus: 'complete' | 'failed', requestedFailureMessage?: string) => {
      if (terminated) return;
      // If the task was stopped by the user, stopAgent already handled cleanup
      if (this.stoppedTasks.has(task.id)) { terminated = true; return; }
      terminated = true;
      const entry = this.sessions.get(task.id) ?? managedEntry;
      if (entry?.timeoutId) clearTimeout(entry.timeoutId);
      const duration = Date.now() - sessionStartTime;

      let status = requestedStatus;
      let failureMessage = requestedFailureMessage;
      let terminalStatusPersisted = false;
      try {
        await this.notifyRunComplete(entry, {
          revisionId: entry.revisionId,
          status,
          agentSummary,
          commitSha,
          pushed,
          error: failureMessage,
        });
        await onStatusChange(status);
        terminalStatusPersisted = true;
      } catch (err: unknown) {
        status = 'failed';
        failureMessage = `Task result persistence failed: ${errorMessage(err)}`;
        console.error(`[agent-manager] ${failureMessage}`);
        try { await entry.onPersistenceFailure?.(failureMessage); } catch (compensationErr: unknown) {
          console.error(`[agent-manager] failed to compensate completion metadata for task ${task.id}:`, errorMessage(compensationErr));
        }
        try { await onStatusChange('failed'); } catch (statusErr: unknown) {
          console.error(`[agent-manager] failed to persist failed status for task ${task.id}:`, errorMessage(statusErr));
        }
        try {
          terminalStatusPersisted = (await this.eventRepo?.getById(task.id))?.agentStatus === 'failed';
        } catch {
          terminalStatusPersisted = false;
        }
      }

      // Emit terminal signals only after result and status persistence have succeeded.
      if (!terminalStatusPersisted) {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: failureMessage || 'Task terminal state could not be persisted. The worktree was preserved for attention.',
          timestamp: Date.now(),
          metadata: { agentType, duration, error: failureMessage },
        });
      } else if (status === 'complete') {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'complete',
          content: 'Task completed successfully.',
          timestamp: Date.now(),
          metadata: { agentType, duration },
        });
      } else {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: failureMessage || 'Task failed.',
          timestamp: Date.now(),
          metadata: { agentType, duration, error: failureMessage },
        });
      }

      if (terminalStatusPersisted) {
        broadcast({
          type: 'agent_complete',
          payload: {
            taskId: task.id,
            status,
            agentType,
            duration,
            eventCount: (await this.getEvents(task.id)).length,
          },
        });
      }

      if (this.sessions.get(task.id) === entry) this.sessions.delete(task.id);
    };

    const provider = this.providers.get(agentType);
    if (!provider) {
      void terminateOnce('failed', `No provider registered for agent type: ${agentType}`);
      return;
    }

    // Check if agent is available
    const agentInfo = this.availableAgents.find(a => a.name === agentType);
    if (!agentInfo?.available) {
      void terminateOnce('failed', `Agent ${provider.displayName} is not available: ${agentInfo?.reason || 'unknown reason'}`);
      return;
    }


    if (options.revision && !providerSupportsRevisionToolGuard(agentType)) {
      void terminateOnce(
        'failed',
        `Agent ${provider.displayName} cannot run a revision safely because its runtime does not expose the required pre-execution push authorization hook.`,
      );
      return;
    }

    // Set up worktree if configured
    let worktreePath: string | undefined;
    let worktreePersisted = Promise.resolve();
    if (task.useWorktree) {
      const priorWorktree = task.worktreePath;
      try {
        worktreePath = this.setupWorktree(task);
        if (worktreePath) {
          task.worktreePath = worktreePath;
          if (onWorktreeCreated) {
            worktreePersisted = Promise.resolve(onWorktreeCreated(worktreePath)).then(() => undefined);
          }
          const reused = priorWorktree != null && path.resolve(priorWorktree) === path.resolve(worktreePath);
          let dirtyHint = '';
          if (reused) {
            try {
              const status = execFileSync('git', ['status', '--porcelain'], {
                cwd: worktreePath, stdio: 'pipe',
              }).toString().trim();
              dirtyHint = status ? '\nNote: worktree has uncommitted changes from a prior run.' : '';
            } catch {
              /* ignore status probe failures */
            }
          }
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'output',
            content: `${reused ? 'Reusing existing git worktree at' : 'Git worktree created at'} ${worktreePath}\nBranch: ${task.branchName}\nBase: ${task.baseBranch || 'main'}${dirtyHint}`,
            timestamp: Date.now(),
          });
        }
      } catch (err: unknown) {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: `Worktree setup failed: ${errorMessage(err)}`,
          timestamp: Date.now(),
        });
        terminateOnce('failed', `Worktree setup failed: ${errorMessage(err)}`);
        return;
      }
    }

    // Launch the agent session asynchronously
    (async () => {
      try {
        await resultResetPersisted;
        await worktreePersisted;
        const workingDirectory = worktreePath || task.repoPath || process.cwd();
        const managesRepository = Boolean(task.repoPath || worktreePath);
        const hasGit = managesRepository && fs.existsSync(path.join(workingDirectory, '.git'));
        const startHeadSha = hasGit ? readGitHead(workingDirectory) : undefined;
        const systemPrompt = buildAgentSystemPrompt(task, workingDirectory, worktreePath, hasGit);
        const revisionPushPermission = resolveRevisionPushPermission(task, options.revision);

        // Track file context across tool_execution_start → command_output pairs
        let lastFileEventFile: string | null = null;
        let lastFileEventType: string | null = null;

        // Accumulate assistant prose ('output' events) to extract the agent's
        // end-of-task <task-summary> marker block after completion.
        let summaryBuffer = '';

        const session = await provider.createSession({
          contextId: task.id,
          workingDirectory,
          repoPath: task.repoPath,
          systemPrompt,
          ...(options.revision ? {
            hooks: {
              onPreToolUse: (input: unknown) => {
                const hookInput = input && typeof input === 'object'
                  ? input as RevisionToolUseInput
                  : {};
                const decision = evaluateRevisionToolUse(hookInput, revisionPushPermission);
                if (decision.permissionDecision === 'deny') {
                  this.emitEvent(task.id, {
                    id: uuid(), taskId: task.id, type: 'error',
                    content: `Blocked unauthorized remote Git mutation: ${decision.permissionDecisionReason}`,
                    timestamp: Date.now(),
                    metadata: {
                      command: `revision-push-block:${decision.operation ?? 'unknown'}`,
                      error: `push-permission:${revisionPushPermission.reason}`,
                    },
                  });
                }
                return decision;
              },
            },
          } : {}),
          onEvent: (coreEvent: CoreAgentEvent) => {
            const metadata: Record<string, unknown> = { ...coreEvent.metadata };
            let eventType = coreEvent.type;
            let content = coreEvent.content;

            // Accumulate raw assistant prose for summary extraction, then strip
            // the literal sentinel tags so they don't render in the Events tab.
            if (coreEvent.type === 'output') {
              summaryBuffer += content;
              if (summaryBuffer.length > MAX_SUMMARY_BUFFER) {
                summaryBuffer = summaryBuffer.slice(-MAX_SUMMARY_BUFFER);
              }
              if (content.includes('task-summary')) {
                content = content.replace(/<\/?task-summary>/g, '');
              }
            }

            // Reclassify 'create' tool as file_write
            if (coreEvent.type === 'command' && metadata.command === 'create') {
              eventType = 'file_write';
            }

            // Enrich file events with metadata.file extracted from tool arguments
            if ((eventType === 'file_write' || eventType === 'file_edit' || eventType === 'file_read') && !metadata.file) {
              const colonIdx = coreEvent.content.indexOf(':');
              if (colonIdx > 0) {
                try {
                  const args = JSON.parse(coreEvent.content.slice(colonIdx + 1).trim());
                  const filePath = args.path || args.file_path || args.file || args.filename;
                  if (filePath) {
                    metadata.file = filePath;
                    lastFileEventFile = filePath;
                    lastFileEventType = eventType;
                  }
                } catch { /* not JSON args, skip */ }
              }
            }

            // Detect file writes from bash commands (cat > file, echo > file, mkdir, etc.)
            if (coreEvent.type === 'command' && metadata.command === 'bash') {
              const content = coreEvent.content;
              // Match: cat > path, cat >> path, echo ... > path, tee path
              const redirectMatch = content.match(/(?:cat|echo|printf)\s+.*?>\s*(\S+)/);
              const teeMatch = content.match(/tee\s+(\S+)/);
              const filePath = redirectMatch?.[1] || teeMatch?.[1];
              if (filePath && !filePath.startsWith('-')) {
                metadata.file = filePath.replace(/['"]/g, '');
                metadata.fileEventType = 'file_write';
              }
            }

            // Carry file metadata from preceding file_write/file_edit to its command_output
            if (coreEvent.type === 'command_output' && lastFileEventFile && lastFileEventType) {
              metadata.file = lastFileEventFile;
              metadata.fileEventType = lastFileEventType;
              lastFileEventFile = null;
              lastFileEventType = null;
            } else if (eventType !== 'file_write' && eventType !== 'file_edit' && eventType !== 'file_read') {
              lastFileEventFile = null;
              lastFileEventType = null;
            }

            this.emitEvent(task.id, {
              id: coreEvent.id,
              taskId: task.id,
              type: eventType as AgentEvent['type'],
              content,
              timestamp: coreEvent.timestamp,
              metadata,
            });
          },
        });

        // The user may stop the task while the provider is still creating its
        // session. In that case stopAgent already finalized the run; never let
        // the late session escape and execute anyway.
        if (!this.sessions.has(task.id)) {
          await session.destroy().catch(() => {});
          return;
        }
        managedEntry.session = session;
        await onStatusChange('executing');

        // Timeout guard. A task override is persisted with the card so retries
        // stay managed by Agent Board instead of escaping to a direct process.
        const taskTimeoutMs = resolveTaskTimeoutMs(task);
        const timeoutId = setTimeout(() => {
          if (!this.sessions.has(task.id)) return;
          const timeoutMsg = `Agent timed out after ${Math.round(taskTimeoutMs / 60000)} minutes`;
          console.warn(`[agent-manager] task ${task.id} timed out after ${taskTimeoutMs}ms`);
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'error',
            content: timeoutMsg,
            timestamp: Date.now(),
          });
          const entry = this.sessions.get(task.id);
          if (entry) {
            entry.session?.abort().catch(() => {});
            entry.session?.destroy().catch(() => {});
          }
          void terminateOnce('failed', timeoutMsg);
        }, taskTimeoutMs);

        const entry = this.sessions.get(task.id);
        if (entry) entry.timeoutId = timeoutId;

        // Build prompt and execute — each provider returns a typed AgentResult
        const prompt = buildAgentExecutionPrompt(task, options.revision);

        // Load image attachments if available
        let agentAttachments: AgentAttachment[] | undefined;
        if (this.attachmentStore) {
          const taskAttachments = await this.attachmentStore.getByTaskId(task.id);
          if (taskAttachments.length > 0) {
            const loaded: AgentAttachment[] = [];
            for (const a of taskAttachments) {
              const srcPath = path.join(UPLOADS_DIR, a.taskId, a.filename);
              const att = loadAttachmentAsBase64(srcPath, a.originalName, a.mimeType);
              if (att) loaded.push(att);
            }
            if (loaded.length > 0) agentAttachments = loaded;
          }
        }

        console.log(`[agent-manager] executing ${agentType} for task ${task.id}${agentAttachments?.length ? ` with ${agentAttachments.length} image(s)` : ''}`);
        const result = await session.execute(prompt, agentAttachments);
        console.log(`[agent-manager] ${agentType} ${result.status} for task ${task.id}${result.error ? `: ${result.error}` : ''}`);

        clearTimeout(timeoutId);

        // Primary completion path — status comes from the provider
        if (this.sessions.has(task.id)) {
          let finalStatus = result.status;
          let finalError = result.error;
          if (finalStatus === 'complete') {
            try {
              agentSummary = extractTaskSummary(summaryBuffer);
              let endHeadSha: string | undefined;
              if (managesRepository) {
                const gitResult = inspectRunCompletion(task, workingDirectory, startHeadSha);
                commitSha = gitResult.commitSha;
                endHeadSha = gitResult.endHeadSha;
                if (gitResult.noChanges && !agentSummary) {
                  agentSummary = '## Completed\nNo changes were required.';
                }
              }
              if (!agentSummary) {
                agentSummary = commitSha
                  ? `## Completed\nChanges committed at ${commitSha}.`
                  : '## Completed\nTask completed with no repository changes.';
              }
              if (!this.eventRepo) throw new Error('task repository is unavailable');
              const persisted = await this.eventRepo.update(task.id, {
                summary: agentSummary,
                commitSha: commitSha ?? null,
              });
              if (!persisted) throw new Error('task result could not be saved');
              if (options.revision) {
                pushed = revisionPushPermission.allowed
                  && isRevisionCommitOnRemote(task, workingDirectory, endHeadSha);
                if (pushed && !commitSha) commitSha = endHeadSha;
              }
            } catch (err: unknown) {
              finalStatus = 'failed';
              finalError = `Completion validation failed: ${errorMessage(err)}`;
            }
          }
          await terminateOnce(finalStatus, finalError);
          session.destroy().catch(() => {});
        }
      } catch (err: unknown) {
        const message = errorMessage(err);
        const isCliMissing =
          message.includes('ENOENT') ||
          message.includes('not found') ||
          message.includes('spawn');

        const errorContent = isCliMissing
          ? `${provider.displayName} CLI is not installed or not found in PATH.`
          : `Failed to start ${provider.displayName} session: ${message}`;

        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: errorContent,
          timestamp: Date.now(),
        });

        await terminateOnce('failed', errorContent);
      }
    })().catch((err: unknown) => {
      console.error(`[agent-manager] unhandled error for task ${task.id}:`, err);
      void terminateOnce('failed', errorMessage(err));
    });
  }

  async sendMessage(taskId: string, message: string, attachmentIds?: string[]): Promise<boolean> {
    const entry = this.sessions.get(taskId);
    if (!entry?.session) return false;

    this.emitEvent(taskId, {
      id: uuid(), taskId, type: 'command',
      content: `Follow-up message sent: ${message}${attachmentIds?.length ? ` (with ${attachmentIds.length} image(s))` : ''}`,
      timestamp: Date.now(),
    });

    // Load attachments if IDs provided
    let agentAttachments: AgentAttachment[] | undefined;
    if (attachmentIds?.length && this.attachmentStore) {
      const loaded: AgentAttachment[] = [];
      for (const id of attachmentIds) {
        const a = await this.attachmentStore.getById(id);
        if (!a) continue;
        const srcPath = path.join(UPLOADS_DIR, a.taskId, a.filename);
        const att = loadAttachmentAsBase64(srcPath, a.originalName, a.mimeType);
        if (att) loaded.push(att);
      }
      if (loaded.length > 0) agentAttachments = loaded;
    }

    try {
      await entry.session.send(message, agentAttachments);
    } catch (err: unknown) {
      const providerName = this.providers.get(entry.agentType)?.displayName || entry.agentType;
      throw new Error(`${providerName} failed to process follow-up: ${errorMessage(err)}`);
    }
    return true;
  }

  async stopAgent(taskId: string): Promise<boolean> {
    const entry = this.sessions.get(taskId);
    if (!entry) return false;

    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    const duration = Date.now() - entry.startTime;
    const { agentType } = entry;
    this.sessions.delete(taskId);
    // Mark as stopped so terminateOnce (from the catch block) won't double-broadcast
    this.stoppedTasks.add(taskId);
    setTimeout(() => this.stoppedTasks.delete(taskId), STOPPED_TASK_TTL_MS);

    (async () => {
      try { await entry.session?.abort(); } catch { /* ignore */ }
      try { await entry.session?.destroy(); } catch { /* ignore */ }
    })();

    this.emitEvent(taskId, {
      id: uuid(), taskId, type: 'error',
      content: 'Agent stopped by user.',
      timestamp: Date.now(),
      metadata: { agentType, duration, error: 'Agent stopped by user.' },
    });

    // Broadcast agent_complete so WS listeners know the agent finished
    broadcast({
      type: 'agent_complete',
      payload: {
        taskId,
        status: 'failed',
        agentType,
        duration,
        eventCount: (await this.getEvents(taskId)).length,
      },
    });

    await this.notifyRunComplete(entry, {
      revisionId: entry.revisionId,
      status: 'failed',
      agentSummary: null,
      pushed: false,
      error: 'Agent stopped by user.',
    });

    // Clean up stale group queue entry if this task belongs to a running group
    for (const [groupId, q] of this.groupQueues) {
      if (q.runningTaskIds.delete(taskId)) {
        q.failedTaskIds.add(taskId);
        Promise.resolve(q.onChildComplete(taskId)).catch((err: unknown) =>
          console.error('[group] onChildComplete failed:', err),
        );
        if (q.pendingTaskIds.length === 0 && q.runningTaskIds.size === 0) {
          this.groupQueues.delete(groupId);
        } else {
          queueMicrotask(() => this.drainGroupQueue(groupId));
        }
        break;
      }
    }

    return true;
  }

  isRunning(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  shutdownAll(): void {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();

    for (const [, entry] of entries) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      (async () => {
        try { await entry.session?.abort(); } catch { /* ignore */ }
        try { await entry.session?.destroy(); } catch { /* ignore */ }
      })();
    }

    for (const provider of this.providers.values()) {
      provider.stop().catch(() => {});
    }
  }

  // ─── Group Queue ──────────────────────────────────────────────────

  isGroupRunning(groupId: string): boolean {
    return this.groupQueues.has(groupId);
  }

  startGroup(
    group: TaskGroup,
    children: Task[],
    makeStatusCb: (task: Task) => (status: Task['agentStatus']) => void | Promise<void>,
    makeWorktreeCb: (task: Task) => (worktreePath: string) => void | Promise<void>,
    onChildComplete: (taskId: string) => void | Promise<void>,
  ): void {
    if (this.groupQueues.has(group.id)) return;

    const queue: GroupQueue = {
      groupId: group.id,
      maxConcurrency: group.maxConcurrency,
      pendingTaskIds: children.map((c) => c.id),
      runningTaskIds: new Set(),
      completedTaskIds: new Set(),
      failedTaskIds: new Set(),
      tasks: new Map(children.map((c) => [c.id, c])),
      makeStatusCallback: makeStatusCb,
      makeWorktreeCallback: makeWorktreeCb,
      onChildComplete,
    };

    this.groupQueues.set(group.id, queue);
    this.drainGroupQueue(group.id);
  }

  private drainGroupQueue(groupId: string): void {
    const queue = this.groupQueues.get(groupId);
    if (!queue) return;

    // Use queueMicrotask to avoid reentrancy issues when startAgent
    // synchronously calls onStatusChange('failed') for unavailable agents
    const startNext = () => {
      const q = this.groupQueues.get(groupId);
      if (!q) return;
      if (q.runningTaskIds.size >= q.maxConcurrency || q.pendingTaskIds.length === 0) return;

      const taskId = q.pendingTaskIds.shift()!;
      const task = q.tasks.get(taskId);
      if (!task) { startNext(); return; }

      q.runningTaskIds.add(taskId);

      const originalStatusCb = q.makeStatusCallback(task);
      const wrappedStatusCb = async (status: Task['agentStatus']) => {
        // Await status persistence so DB is consistent before completion check
        await originalStatusCb(status);

        if (status === 'complete' || status === 'failed') {
          q.runningTaskIds.delete(taskId);
          if (status === 'complete') {
            q.completedTaskIds.add(taskId);
          } else {
            q.failedTaskIds.add(taskId);
          }

          // Notify completion (catch to prevent unhandled rejection crash)
          Promise.resolve(q.onChildComplete(taskId)).catch((err: unknown) =>
            console.error('[group] onChildComplete failed:', err),
          );

          // Clean up queue when fully drained
          if (q.pendingTaskIds.length === 0 && q.runningTaskIds.size === 0) {
            this.groupQueues.delete(groupId);
          } else {
            queueMicrotask(() => this.drainGroupQueue(groupId));
          }
        }
      };

      this.startAgent(task, wrappedStatusCb, q.makeWorktreeCallback(task));

      // Start more if we haven't hit concurrency limit
      startNext();
    };

    startNext();
  }

  async stopGroup(groupId: string): Promise<void> {
    const queue = this.groupQueues.get(groupId);
    if (!queue) return;

    // Clear pending
    queue.pendingTaskIds.length = 0;

    // Stop running children
    const running = [...queue.runningTaskIds];
    for (const taskId of running) {
      await this.stopAgent(taskId);
    }

    this.groupQueues.delete(groupId);
  }
}
