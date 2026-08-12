import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Markdown from 'react-markdown';
import {
  X,
  Brain,
  Terminal,
  FileCode2,
  Cog,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  Play,
  Square,
  GitBranch,
  ExternalLink,
  GitMerge,
  Trash2,
  FileText,
  RotateCw,
  Download,
} from 'lucide-react';
import type { Task, TaskRevision, RequestChangesResponse, AgentEvent, AgentEventType } from '@/types';
import { getAgentDisplay } from '@/lib/agent-config';
import { TerminalView } from './TerminalView';
import { api, connectWS } from '@/lib/api';
import { cn } from '@/lib/utils';

const eventIconMap: Record<AgentEventType, React.ElementType> = {
  thinking: Brain,
  tool_call: Cog,
  file_read: FileText,
  file_write: FileCode2,
  file_edit: FileCode2,
  command: Terminal,
  command_output: Terminal,
  output: Terminal,
  test_result: CheckCircle2,
  error: AlertCircle,
  complete: CheckCircle2,
};

const eventColorMap: Record<AgentEventType, string> = {
  thinking: 'text-purple-500 dark:text-purple-400',
  tool_call: 'text-blue-500 dark:text-blue-400',
  file_read: 'text-sky-500 dark:text-sky-400',
  file_write: 'text-amber-500 dark:text-amber-400',
  file_edit: 'text-amber-500 dark:text-amber-400',
  command: 'text-cyan-600 dark:text-cyan-400',
  command_output: 'text-zinc-500 dark:text-zinc-400',
  output: 'text-zinc-500 dark:text-zinc-400',
  test_result: 'text-emerald-500 dark:text-emerald-400',
  error: 'text-red-500 dark:text-red-400',
  complete: 'text-emerald-500 dark:text-emerald-400',
};

const eventLabelMap: Record<AgentEventType, string> = {
  thinking: 'Thinking',
  tool_call: 'Tool Call',
  file_read: 'File Read',
  file_write: 'File Write',
  file_edit: 'File Edit',
  command: 'Command',
  command_output: 'Output',
  output: 'Output',
  test_result: 'Test Result',
  error: 'Error',
  complete: 'Complete',
};

/** A coalesced event merges consecutive events of the same type */
interface CoalescedEvent extends AgentEvent {
  /** Parsed label for command events (e.g. "bash") */
  toolLabel?: string;
  /** Parsed arguments for command events */
  toolArgs?: string;
}

/** Strip build-progress noise (dotnet timestamps, bare fragments) from output content */
function stripProgressNoise(content: string): string {
  return content.split('\n').filter(l => {
    const trimmed = l.trim();
    if (trimmed.length === 0) return false;
    const clean = trimmed.replace(/\x1b\[[0-9;]*m/g, '');
    // Filter progress timestamps: (0.3s), (1.2s)csproj, etc.
    if (/^\(?\d+\.\d+s\)/.test(clean)) return false;
    // Filter bare fragments that are just part of progress output
    if (/^(csproj|sln|props|targets)$/i.test(clean)) return false;
    return true;
  }).join('\n');
}

/** Merge consecutive events of the same mergeable type */
function coalesceEvents(events: AgentEvent[], streaming: boolean): CoalescedEvent[] {
  const result: CoalescedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    let event = events[i];

    // Strip build-progress noise from command output
    if (event.type === 'command_output') {
      const cleaned = stripProgressNoise(event.content);
      if (!cleaned.trim()) continue; // nothing meaningful left
      event = { ...event, content: cleaned };
    }

    // Skip empty content events (shouldn't exist but guards against bad data)
    if (!event.content?.trim() && event.type !== 'complete' && event.type !== 'error') continue;

    // Hide thinking events that are still actively streaming
    // (i.e. the last run of thinking events with no non-thinking event after them)
    if (event.type === 'thinking' && streaming) {
      // Check if there's a non-thinking event after this run of thinking events
      let hasFollowUp = false;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].type !== 'thinking') { hasFollowUp = true; break; }
      }
      if (!hasFollowUp) continue; // skip — still streaming thinking
    }

    // Mergeable types: thinking, output, command_output
    if (event.type === 'thinking' || event.type === 'output' || event.type === 'command_output') {
      // Check if last coalesced entry is the same type — merge
      // Also merge command_output into output and vice versa
      const last = result[result.length - 1];
      const mergeable = last && (last.type === event.type ||
        (last.type === 'output' && event.type === 'command_output') ||
        (last.type === 'command_output' && event.type === 'output'));
      if (mergeable) {
        // Concatenate directly — content already includes natural newlines
        last.content += event.content;
        continue;
      }
    }

    // Parse command events: content is like 'bash: {"command":"...","description":"..."}'
    if (event.type === 'command') {
      const parsed = parseCommandEvent(event);
      result.push(parsed);
      continue;
    }

    result.push({ ...event });
  }
  return result;
}

/** Parse command event content like 'bash: {"command":"python3 hello.py","description":"Run hello"}' */
function parseCommandEvent(event: AgentEvent): CoalescedEvent {
  const colonIdx = event.content.indexOf(': ');
  if (colonIdx === -1) return { ...event };

  const toolLabel = event.content.slice(0, colonIdx);
  const jsonStr = event.content.slice(colonIdx + 2);

  try {
    const parsed = JSON.parse(jsonStr);
    // Show the actual command or a description
    const display = parsed.command || parsed.description || jsonStr;
    return { ...event, toolLabel, toolArgs: display };
  } catch {
    // Not valid JSON — just show the raw content after the tool name
    return { ...event, toolLabel, toolArgs: jsonStr };
  }
}

/** Detect if content looks like code (backticks, common code patterns) */
function looksLikeCode(text: string): boolean {
  if (text.includes('`')) return true;
  const lines = text.split('\n');
  const codePatterns = /^(import |export |const |let |var |function |class |if \(|for \(|while \(|return |async |await |\/\/|#include|def |package )/;
  return lines.some((line) => codePatterns.test(line.trimStart()));
}

/** Pretty-print a JSON string, or return null if it isn't JSON. */
function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/**
 * Derive a readable detail string for tool_call / file_* events. ACP agents
 * (Hermes, OpenClaw) emit these types with content shaped as raw JSON or
 * "Title: {json}"; pretty-print the args/output so clicking shows real detail.
 */
function deriveToolDetail(content: string | undefined): string | null {
  const raw = content?.trim();
  if (!raw) return null;
  const wholePretty = tryPrettyJson(raw);
  if (wholePretty) return wholePretty;
  const colonIdx = raw.indexOf(': ');
  if (colonIdx > 0) {
    const afterPretty = tryPrettyJson(raw.slice(colonIdx + 2));
    if (afterPretty) return afterPretty;
  }
  return raw;
}

/** Collapse content to a single-line, truncated summary for the event header. */
function compactToolSummary(content: string | undefined): string | null {
  const raw = content?.trim();
  if (!raw) return null;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 80) + '...' : oneLine;
}


interface AgentPanelProps {
  task: Task | null;
  onClose: () => void;
  onRun?: (id: string) => void;
  onStop?: (id: string) => void;
  onRequestChanges?: (id: string, feedback: string) => Promise<RequestChangesResponse | undefined>;
  onCreatePR?: (id: string) => Promise<string | undefined>;
  onMergeLocal?: (id: string) => Promise<string | undefined>;
  onCleanupWorktree?: (id: string) => Promise<void>;
  onReconfigureRetry?: (id: string) => void;
  theme?: 'dark' | 'light';
}

type AgentPanelTab = 'summary' | 'events' | 'terminal' | 'changes' | 'revisions';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(timerRef.current); }, []);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch((err) => {
      console.warn('[clipboard] copy failed:', err);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function EventItem({ event }: { event: CoalescedEvent }) {
  // Thinking events default to collapsed; everything else expanded
  const [expanded, setExpanded] = useState(event.type !== 'thinking');
  const Icon = eventIconMap[event.type];
  const color = eventColorMap[event.type];
  const label = event.toolLabel
    ? event.toolLabel.charAt(0).toUpperCase() + event.toolLabel.slice(1)
    : eventLabelMap[event.type];

  const hasDiff = event.metadata?.diff;
  const hasFile = event.metadata?.file;

  // tool_call / file_* events (common for ACP agents like Hermes/OpenClaw) have
  // no command-style parsing, so derive a readable detail + header summary.
  const isToolDetailType =
    event.type === 'tool_call' ||
    event.type === 'file_read' ||
    event.type === 'file_write' ||
    event.type === 'file_edit';
  const toolDetail = isToolDetailType && !hasDiff ? deriveToolDetail(event.content) : null;

  // For parsed commands, show the command string in the header
  // For file events, show just the filename (basename) from metadata
  const fileLabel = (event.type === 'file_read' || event.type === 'file_write' || event.type === 'file_edit')
    ? (event.metadata?.file ? event.metadata.file.split('/').pop() : null)
    : null;
  const headerSummary = event.toolArgs
    ? event.toolArgs.length > 80 ? event.toolArgs.slice(0, 80) + '...' : event.toolArgs
    : fileLabel ?? (isToolDetailType ? compactToolSummary(event.content) : null);

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
      className={cn(
        'group',
        event.type === 'error' && 'rounded-lg border border-red-500/20 bg-red-500/5'
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent/50 transition-colors"
      >
        <div className={cn('mt-0.5 shrink-0', color)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">
              {label}
            </span>
            {headerSummary && (
              <span className="truncate text-[10px] text-muted-foreground font-mono">
                {headerSummary}
              </span>
            )}
            {!headerSummary && hasFile && (
              <span className="truncate text-[10px] text-muted-foreground font-mono">
                {event.metadata!.file}
              </span>
            )}
            <ChevronRight
              className={cn(
                'ml-auto h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform',
                expanded && 'rotate-90'
              )}
            />
          </div>
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="ml-6 mr-2 mb-2">
              {/* Thinking / text content — render as code block if it looks like code */}
              {(event.type === 'thinking' || event.type === 'complete' || event.type === 'error') && (
                looksLikeCode(event.content) ? (
                  <div className="rounded-md px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap" style={{ backgroundColor: 'var(--code-bg)', color: 'var(--code-text)' }}>
                    {event.content}
                  </div>
                ) : (
                  <p className={cn(
                    'text-xs leading-relaxed whitespace-pre-wrap',
                    event.type === 'error'
                      ? 'font-mono text-red-700 dark:text-red-300'
                      : 'text-muted-foreground'
                  )}>
                    {event.content}
                  </p>
                )
              )}

              {/* Command — user follow-up messages have distinct styling */}
              {event.type === 'command' && event.content.startsWith('You: ') && (
                <div className="rounded-md bg-sky-500/10 border border-sky-500/20 px-2.5 py-1.5 text-xs text-sky-700 dark:text-sky-300">
                  {event.content}
                </div>
              )}

              {/* Command — show parsed command cleanly */}
              {event.type === 'command' && !event.content.startsWith('You: ') && (
                <div className="flex items-center gap-1 rounded-md px-2.5 py-1.5 font-mono text-xs" style={{ backgroundColor: 'var(--code-bg)', color: 'var(--code-command)' }}>
                  <span className="text-muted-foreground select-none">$</span>
                  <span className="flex-1">{event.toolArgs || event.content}</span>
                  <CopyButton text={event.toolArgs || event.content} />
                </div>
              )}

              {/* Output — render as prose if it's natural language, code block if it looks like code */}
              {event.type === 'output' && (
                looksLikeCode(event.content) ? (
                  <div className="rounded-md px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap" style={{ backgroundColor: 'var(--code-bg)', color: 'var(--code-text)' }}>
                    {event.content}
                  </div>
                ) : (
                  <div className="text-xs leading-relaxed text-foreground/70 whitespace-pre-wrap [&>*:first-child]:mt-0">
                    {event.content.split(/\n{2,}/).map((paragraph, i) => (
                      <p key={i} className={i > 0 ? 'mt-2.5 pt-2.5 border-t border-border/30' : ''}>
                        {paragraph}
                      </p>
                    ))}
                  </div>
                )
              )}

              {/* Tool call / file operation — show the file path and tool args/output.
                  Covers ACP agents (Hermes/OpenClaw) whose activity arrives as
                  tool_call/file_* events rather than command/output. */}
              {isToolDetailType && (
                <div className="space-y-1">
                  {hasFile && (
                    <div className="font-mono text-[11px] text-muted-foreground break-all">
                      {event.metadata!.file}
                    </div>
                  )}
                  {toolDetail && (
                    <div className="flex items-start gap-1 rounded-md px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap" style={{ backgroundColor: 'var(--code-bg)', color: 'var(--code-text)' }}>
                      <span className="flex-1 overflow-x-auto">{toolDetail}</span>
                      <CopyButton text={toolDetail} />
                    </div>
                  )}
                </div>
              )}

              {/* Diff */}
              {hasDiff && (
                <div className="mt-1 overflow-x-auto rounded-md p-2.5 font-mono text-[11px] leading-relaxed" style={{ backgroundColor: 'var(--code-bg)' }}>
                  {event.metadata!.diff!.split('\n').map((line, i) => (
                    <div
                      key={i}
                      style={
                        line.startsWith('+') && !line.startsWith('++')
                          ? { color: 'var(--code-diff-add-text)', backgroundColor: 'var(--code-diff-add-bg)' }
                          : line.startsWith('-') && !line.startsWith('--')
                          ? { color: 'var(--code-diff-del-text)', backgroundColor: 'var(--code-diff-del-bg)' }
                          : { color: 'var(--code-diff-neutral)' }
                      }
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function AgentPanel({ task, onClose, onRun, onStop, onRequestChanges, onCreatePR, onMergeLocal, onCleanupWorktree, onReconfigureRetry, theme }: AgentPanelProps) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<string | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<TaskRevision[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [requestChangesError, setRequestChangesError] = useState<string | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<AgentPanelTab>('events');
  // Tracks whether the user manually picked a tab for the current task, so the
  // auto-default (Summary for review/done) doesn't clobber an explicit choice.
  const userSelectedTabRef = useRef(false);
  const agentDisplay = task?.agentType ? getAgentDisplay(task.agentType) : undefined;
  const [showWorktreeConfirm, setShowWorktreeConfirm] = useState(false);
  const [hasRemote, setHasRemote] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const taskId = task?.id ?? null;
  const agentStatus = task?.agentStatus;
  const columnId = task?.columnId;
  const errorEvents = useMemo(() => events.filter((event) => event.type === 'error'), [events]);
  const latestError = errorEvents[errorEvents.length - 1];

  useEffect(() => {
    if (!taskId) {
      setEvents([]);
      setPrUrl(null);
      setPrLoading(false);
      return;
    }

    // Reset state for new task
    setPrUrl(task?.prUrl ?? null);
    setPrLoading(false);
    setPrError(null);
    setMergeResult(null);
    setMergeLoading(false);
    setMergeError(null);
    setShowWorktreeConfirm(false);
    setHasRemote(null);
    setFeedback('');
    setRequestingChanges(false);
    setRequestChangesError(null);
    // Allow the auto-default tab to apply for the newly selected task
    userSelectedTabRef.current = false;

    // Load existing events from server
    api.getEvents(taskId).then(setEvents).catch(console.error);

    // Check if repo has a git remote (for showing Create PR vs Merge to main)
    api.getGitInfo(taskId).then((info) => setHasRemote(info.hasRemote)).catch(() => setHasRemote(false));

    // Listen for live agent events via WS
    const disconnect = connectWS((msg) => {
      if (msg.type === 'agent_event') {
        if (msg.payload.taskId === taskId) {
          // Deduplicate by event id — historical load + live WS can overlap
          setEvents((prev) => {
            if (msg.payload.id && prev.some((e) => e.id === msg.payload.id)) return prev;
            return [...prev, msg.payload];
          });
          if (msg.payload.type === 'complete' || msg.payload.type === 'error') {
            setStreaming(false);
          }
        }
      }
    });

    return () => {
      disconnect();
      setStreaming(false);
    };
  }, [taskId]);

  useEffect(() => {
    if (!taskId) {
      setRevisions([]);
      setRevisionsLoading(false);
      setRevisionsError(null);
      return;
    }

    let cancelled = false;
    setRevisionsLoading(true);
    setRevisionsError(null);
    api.getRevisions(taskId)
      .then((loaded) => {
        if (!cancelled) setRevisions(loaded);
      })
      .catch((err: Error) => {
        if (!cancelled) setRevisionsError(err.message || '无法加载修改记录');
      })
      .finally(() => {
        if (!cancelled) setRevisionsLoading(false);
      });

    return () => { cancelled = true; };
  }, [taskId]);

  // Fix #4: Sync streaming state with agentStatus (avoids stale closure on [taskId] effect)
  useEffect(() => {
    if (!taskId) return;
    const isActive = agentStatus === 'executing' || agentStatus === 'planning';
    setStreaming(isActive);
  }, [taskId, agentStatus]);

  // Default to the Summary tab for review/done tasks (and auto-switch when a task
  // moves into review on completion), unless the user picked a tab themselves.
  useEffect(() => {
    if (!taskId) return;
    if (columnId !== 'review' && columnId !== 'done' && activeTab === 'summary') {
      setActiveTab('events');
      return;
    }
    if (userSelectedTabRef.current) return;
    if (columnId === 'review' || columnId === 'done') {
      setActiveTab('summary');
    } else {
      setActiveTab('events');
    }
  }, [taskId, columnId, activeTab]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const isActive = task?.agentStatus === 'executing' || task?.agentStatus === 'planning';

  const selectTab = (tab: AgentPanelTab) => {
    userSelectedTabRef.current = true;
    setActiveTab(tab);
  };
  const showSummaryTab = columnId === 'review' || columnId === 'done';
  const summaryText = task?.summary ?? null;
  const displayedPrUrl = task?.prUrl ?? prUrl;
  const hasHeldRevisions = revisions.some((revision) => revision.pushStatus === 'held');
  // The "Completed" section is required; flag when it's missing or empty.
  const completedSectionFilled = useMemo(() => {
    if (!summaryText) return false;
    const m = summaryText.match(/##\s*Completed\s*\r?\n([\s\S]*?)(?:\r?\n##\s|$)/i);
    return !!(m && m[1].trim().length > 0);
  }, [summaryText]);

  const coalescedEvents = useMemo(
    () => coalesceEvents(events, streaming),
    [events, streaming]
  );

  // Derive file changes for the Changes tab
  const fileChanges = useMemo(() => {
    const files = new Map<string, { type: 'created' | 'modified' | 'read'; content: string; diff?: string }>();
    for (const event of events) {
      const file = event.metadata?.file;
      if (!file) continue;
      if (event.type === 'file_write') {
        files.set(file, { type: files.has(file) ? 'modified' : 'created', content: event.content, diff: event.metadata?.diff });
      } else if (event.type === 'file_edit') {
        files.set(file, { type: 'modified', content: event.content, diff: event.metadata?.diff });
      } else if (event.type === 'command' && event.metadata?.fileEventType === 'file_write') {
        // bash commands that write files (cat > file, etc.)
        files.set(file, { type: files.has(file) ? 'modified' : 'created', content: event.content });
      } else if (event.type === 'command_output' && event.metadata?.fileEventType) {
        const isWrite = event.metadata.fileEventType === 'file_write' || event.metadata.fileEventType === 'file_edit';
        if (isWrite) {
          files.set(file, { type: files.has(file) ? 'modified' : 'created', content: event.content, diff: event.metadata?.diff });
        }
      } else if (event.type === 'file_read' && !files.has(file)) {
        files.set(file, { type: 'read', content: event.content });
      }
    }
    return [...files.entries()].map(([path, info]) => ({ path, ...info }));
  }, [events]);

  const failedWithoutDetails = task?.agentStatus === 'failed' && !latestError;

  const handleRequestChanges = async () => {
    const trimmedFeedback = feedback.trim();
    if (!task || task.columnId !== 'review' || !trimmedFeedback || requestingChanges) return;
    if (!onRequestChanges) {
      setRequestChangesError('当前无法发起修改，请刷新后重试。');
      return;
    }

    setRequestingChanges(true);
    setRequestChangesError(null);
    const result = await onRequestChanges(task.id, trimmedFeedback);
    setRequestingChanges(false);
    if (!result) {
      setRequestChangesError('发起修改失败，请检查任务状态后重试。');
      return;
    }

    setRevisions((current) => current.some((revision) => revision.id === result.revision.id)
      ? current
      : [...current, result.revision]);
    setFeedback('');
  };

  return (
    <AnimatePresence>
      {task && (
        <>
          {/* Backdrop overlay — click to close */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[55]"
            style={{ backgroundColor: 'var(--overlay-bg)' }}
          />
          <motion.div
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 z-[60] flex h-full w-full flex-col border-l border-border bg-card shadow-2xl md:max-w-md md:w-[420px]"
          >
          {/* Progress bar */}
          {(task.agentStatus === 'planning' || task.agentStatus === 'executing' || task.agentStatus === 'complete') && (
            <div className="h-1 w-full bg-muted shrink-0">
              <div
                className={cn(
                  'h-full rounded-r transition-all duration-700 ease-in-out',
                  task.agentStatus === 'complete'
                    ? 'w-full bg-emerald-500'
                    : task.agentStatus === 'executing'
                      ? 'w-3/5 bg-primary animate-pulse'
                      : 'w-1/4 bg-purple-500 animate-pulse'
                )}
              />
            </div>
          )}

          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold">{task.title}</h3>
              <div className="mt-0.5 flex items-center gap-2">
                {task.agentType && agentDisplay && (
                  <span className="text-[10px] text-muted-foreground">
                    {agentDisplay.emoji} {agentDisplay.label}
                  </span>
                )}
                {isActive && (
                  <span className="flex items-center gap-1 text-[10px] text-primary">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                    </span>
                    Active
                  </span>
                )}
                {task.agentStatus === 'complete' && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Complete
                  </span>
                )}
                {task.agentStatus === 'failed' && (
                  <span className="flex items-center gap-1 text-[10px] text-red-600 dark:text-red-400">
                    <AlertCircle className="h-3 w-3" />
                    Failed
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {events.length} events
                </span>
              </div>
            </div>
            <div className="ml-3 flex items-center gap-1.5">
              {/* Run / Stop / Retry buttons */}
              {!isActive && task.agentStatus !== 'complete' && onRun && (
                <button
                  onClick={() => onRun(task.id)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                  title={task.agentStatus === 'failed' ? 'Retry agent' : 'Run agent'}
                >
                  {task.agentStatus === 'failed' ? <RotateCw className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </button>
              )}
              {!isActive && task.agentStatus === 'failed' && onReconfigureRetry && (
                <button
                  onClick={() => onReconfigureRetry(task.id)}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-muted px-3 text-xs font-medium text-amber-500 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
                  title="Reconfigure and retry"
                >
                  <Cog className="h-3.5 w-3.5" />
                  Reconfigure
                </button>
              )}
              {isActive && onStop && (
                <button
                  onClick={() => onStop(task.id)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-red-500 dark:text-red-400 hover:bg-red-500/20 transition-colors"
                  title="Stop agent"
                >
                  <Square className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={onClose}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-foreground hover:bg-destructive hover:text-white hover:border-destructive transition-colors"
                title="Close panel (Esc)"
              >
                <X className="h-5 w-5" strokeWidth={2.5} />
              </button>
            </div>
          </div>

          {/* Task description as collapsible markdown */}
          {/* WARNING: Do NOT add rehype-raw — it would allow raw HTML injection (XSS). */}
          {task.description && (
            <div className="shrink-0 border-b border-border">
              <button
                onClick={() => setDescExpanded(!descExpanded)}
                className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-accent/50 transition-colors"
              >
                <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs font-medium text-foreground">Task Description</span>
                <span className="text-[10px] text-muted-foreground ml-1">
                  {task.description.length > 200 ? `${Math.round(task.description.length / 100) * 100}+ chars` : ''}
                </span>
                {descExpanded
                  ? <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  : <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground shrink-0" />
                }
              </button>
              <AnimatePresence>
                {descExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                  >
                    <div className="max-h-[30vh] overflow-y-auto px-4 pb-3 prose prose-xs dark:prose-invert max-w-none text-xs text-muted-foreground leading-relaxed [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[11px] [&_a]:text-primary [&_a]:underline" style={{ '--tw-prose-code-bg': 'var(--prose-code-bg)' } as React.CSSProperties}>
                      <style>{`.prose code { background-color: var(--prose-code-bg); } .prose pre { background-color: var(--code-bg); padding: 0.5rem; border-radius: 0.375rem; }`}</style>
                      <Markdown
                        allowedElements={[
                          'p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a',
                          'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'br',
                          'table', 'thead', 'tbody', 'tr', 'th', 'td',
                        ]}
                      >
                        {task.description}
                      </Markdown>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Worktree info bar */}
          {task.branchName && (
            <div className="shrink-0 border-b border-border px-4 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <GitBranch className="h-3 w-3 text-primary" />
                <span className="font-mono text-foreground">{task.branchName}</span>
                <span className="text-muted-foreground/50">from</span>
                <span className="font-mono">{task.baseBranch || 'main'}</span>
              </div>
              {task.worktreePath && (
                <div className="text-[10px] text-muted-foreground font-mono truncate">
                  {task.worktreePath}
                </div>
              )}

              {/* PR / Cleanup actions — show when task is done or complete */}
              {(task.agentStatus === 'complete' || task.columnId === 'done') && (
                <div className="flex items-center gap-2 pt-1">
                  {!displayedPrUrl && onCreatePR && hasRemote === true && (
                    <button
                      onClick={async () => {
                        setPrLoading(true);
                        setPrError(null);
                        try {
                          const url = await onCreatePR(task.id);
                          if (url) setPrUrl(url);
                        } catch (err: unknown) {
                          setPrError((err as Error).message || 'Failed to create PR');
                        }
                        setPrLoading(false);
                      }}
                      disabled={prLoading}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {prLoading ? 'Creating...' : 'Create PR'}
                    </button>
                  )}
                  {displayedPrUrl && (
                    <a
                      href={displayedPrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                    >
                      <ExternalLink className="h-3 w-3" />
                      View PR
                    </a>
                  )}
                  {!mergeResult && task.branchName && onMergeLocal && (
                    <button
                      onClick={async () => {
                        setMergeLoading(true);
                        setMergeError(null);
                        try {
                          const branch = await onMergeLocal(task.id);
                          if (branch) setMergeResult(branch);
                        } catch (err: unknown) {
                          setMergeError((err as Error).message || 'Failed to merge');
                        }
                        setMergeLoading(false);
                      }}
                      disabled={mergeLoading}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                    >
                      <GitMerge className="h-3 w-3" />
                      {mergeLoading ? 'Merging...' : `Merge to ${task.baseBranch || 'main'}`}
                    </button>
                  )}
                  {mergeResult && (
                    <span className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
                      <GitMerge className="h-3 w-3" />
                      Merged to {mergeResult}
                    </span>
                  )}
                  {task.worktreePath && onCleanupWorktree && (
                    <button
                      onClick={() => setShowWorktreeConfirm(true)}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                      Clean up worktree
                    </button>
                  )}
                </div>
              )}

              {/* PR / merge errors */}
              {prError && <ErrorBanner message={prError} onDismiss={() => setPrError(null)} />}
              {mergeError && <ErrorBanner message={mergeError} onDismiss={() => setMergeError(null)} />}
            </div>
          )}
          {showWorktreeConfirm && (
            <div className="mx-4 my-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="text-xs text-amber-200 font-medium mb-1">Delete worktree?</p>
              <p className="text-xs text-amber-300/80 mb-3">
                This removes the worktree directory and its files. If you haven't created a PR yet, you won't be able to push these changes afterward.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowWorktreeConfirm(false)}
                  className="rounded px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setShowWorktreeConfirm(false);
                    if (task && onCleanupWorktree) onCleanupWorktree(task.id);
                  }}
                  className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500"
                >
                  Delete worktree
                </button>
              </div>
            </div>
          )}

          {task.agentStatus === 'failed' && (
            <FailureSummary
              message={latestError?.content || 'The agent failed before it wrote an error log. Retry or reconfigure the task to capture the current failure reason.'}
            />
          )}

          {/* Tab bar */}
          <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border px-2 pt-1">
            <div className="min-w-0 flex flex-1 gap-0.5 overflow-x-auto">
            {showSummaryTab && (
              <button
                onClick={() => selectTab('summary')}
                className={cn(
                  'shrink-0 whitespace-nowrap px-2.5 py-1.5 text-xs font-medium rounded-t transition-colors',
                  activeTab === 'summary'
                    ? 'bg-card border border-border border-b-card text-foreground -mb-px'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Summary
              </button>
            )}
            <button
              onClick={() => selectTab('events')}
              className={cn(
                'shrink-0 whitespace-nowrap px-2.5 py-1.5 text-xs font-medium rounded-t transition-colors',
                activeTab === 'events'
                  ? 'bg-card border border-border border-b-card text-foreground -mb-px'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Events
            </button>
            <button
              onClick={() => selectTab('terminal')}
              className={cn(
                'shrink-0 whitespace-nowrap px-2.5 py-1.5 text-xs font-medium rounded-t transition-colors',
                activeTab === 'terminal'
                  ? 'bg-card border border-border border-b-card text-foreground -mb-px'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Terminal
            </button>
            <button
              onClick={() => selectTab('changes')}
              className={cn(
                'shrink-0 whitespace-nowrap px-2.5 py-1.5 text-xs font-medium rounded-t transition-colors',
                activeTab === 'changes'
                  ? 'bg-card border border-border border-b-card text-foreground -mb-px'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Actions{fileChanges.length > 0 ? ` (${fileChanges.length})` : ''}
            </button>
            <button
              onClick={() => selectTab('revisions')}
              className={cn(
                'shrink-0 whitespace-nowrap px-2.5 py-1.5 text-xs font-medium rounded-t transition-colors',
                activeTab === 'revisions'
                  ? 'bg-card border border-border border-b-card text-foreground -mb-px'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              修改记录 ({revisions.length})
            </button>
            </div>
            {events.length > 0 && (
              <button
                onClick={() => {
                  const md = events.map((e) => {
                    const label = eventLabelMap[e.type] || e.type;
                    const meta = e.metadata?.file ? ` (${e.metadata.file})` : '';
                    return `### ${label}${meta}\n${e.content}`;
                  }).join('\n\n');
                  const blob = new Blob([`# Agent Log — ${task.title}\n\n${md}`], { type: 'text/markdown' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = `agent-log-${task.id}.md`; a.click();
                  URL.revokeObjectURL(url);
                }}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                title="Download event log as markdown"
              >
                <Download className="h-3 w-3" />
                Export
              </button>
            )}
          </div>

          {/* Summary view */}
          {activeTab === 'summary' && (
            <section aria-label="Summary" className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {hasHeldRevisions && <HeldRevisionNotice />}
                {summaryText ? (
                  <>
                    {!completedSectionFilled && (
                      <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        The required “Completed” section is empty or missing.
                      </div>
                    )}
                    <div className="prose prose-sm dark:prose-invert max-w-none text-foreground [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2:first-child]:mt-0">
                      <Markdown>{summaryText}</Markdown>
                    </div>
                  </>
                ) : (
                  <div className="flex min-h-48 items-center justify-center">
                    <div className="text-center">
                      <FileText className="mx-auto h-10 w-10 text-muted-foreground/20" />
                      <p className="mt-3 text-sm text-muted-foreground/50">No summary was provided for this task.</p>
                    </div>
                  </div>
                )}
              </div>

              {columnId === 'review' && (
                <div className="shrink-0 border-t border-border bg-card px-4 py-3">
                  <label htmlFor={`review-feedback-${task.id}`} className="mb-2 block text-xs font-semibold text-foreground">
                    修改意见
                  </label>
                  <textarea
                    id={`review-feedback-${task.id}`}
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value)}
                    placeholder="填写修改意见…"
                    rows={3}
                    disabled={requestingChanges}
                    className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  {requestChangesError && (
                    <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
                      {requestChangesError}
                    </p>
                  )}
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={handleRequestChanges}
                      disabled={requestingChanges || feedback.trim().length === 0}
                      className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {requestingChanges ? '正在发起…' : '发起修改'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Terminal view */}
          {activeTab === 'terminal' && (
            <div className={cn('flex-1 overflow-hidden rounded-none', theme === 'light' ? 'bg-[#f8f9fb]' : 'bg-[#0f172a]')}>
              <TerminalView events={events} streaming={streaming} theme={theme} />
            </div>
          )}

          {/* Changes list */}
          {activeTab === 'changes' && (
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {fileChanges.length === 0 && (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <FileCode2 className="mx-auto h-10 w-10 text-muted-foreground/20" />
                    <p className="mt-3 text-sm text-muted-foreground/50">No actions yet</p>
                  </div>
                </div>
              )}
              {fileChanges.map((file) => (
                <details key={file.path} className="group rounded-lg border border-border bg-card">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50">
                    <span>{file.type === 'created' ? '🟢' : file.type === 'modified' ? '🟡' : '📖'}</span>
                    <span className="flex-1 font-mono text-xs text-foreground truncate" title={file.path}>{file.path}</span>
                    <span className="text-[10px] text-muted-foreground capitalize">{file.type}</span>
                  </summary>
                  <div className="border-t border-border px-3 py-2 overflow-x-auto">
                    <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">{file.diff || file.content}</pre>
                  </div>
                </details>
              ))}
            </div>
          )}

          {/* Events list */}
          {activeTab === 'events' && (
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-2 space-y-0.5"
          >
            {coalescedEvents.length === 0 && !streaming && failedWithoutDetails && (
              <div className="flex h-full items-center justify-center p-4">
                <div className="w-full rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-center">
                  <AlertCircle className="mx-auto h-10 w-10 text-red-500/80 dark:text-red-400/80" />
                  <p className="mt-3 text-sm font-medium text-red-700 dark:text-red-300">
                    Agent failed
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-red-700/70 dark:text-red-300/70">
                    This run did not record an error event. Use Reconfigure or Retry to run it again and capture details.
                  </p>
                </div>
              </div>
            )}

            {coalescedEvents.length === 0 && !streaming && !failedWithoutDetails && (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <Brain className="mx-auto h-10 w-10 text-muted-foreground/20" />
                  <p className="mt-3 text-sm text-muted-foreground/50">
                    No agent activity yet
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground/30">
                    Assign this task to start the agent
                  </p>
                </div>
              </div>
            )}

            {coalescedEvents.map((event) => (
              <EventItem key={event.id} event={event} />
            ))}

            {/* Streaming indicator */}
            {streaming && coalescedEvents.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-2 px-2 py-2"
              >
                <div className="flex gap-1">
                  <motion.div
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ repeat: Infinity, duration: 1.2, delay: 0 }}
                    className="h-1 w-1 rounded-full bg-primary"
                  />
                  <motion.div
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ repeat: Infinity, duration: 1.2, delay: 0.2 }}
                    className="h-1 w-1 rounded-full bg-primary"
                  />
                  <motion.div
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ repeat: Infinity, duration: 1.2, delay: 0.4 }}
                    className="h-1 w-1 rounded-full bg-primary"
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">
                  Agent is working...
                </span>
              </motion.div>
            )}
          </div>
          )}

          {activeTab === 'revisions' && (
            <RevisionHistory
              key={task.id}
              revisions={revisions}
              loading={revisionsLoading}
              error={revisionsError}
            />
          )}
        </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

const revisionStatusDisplay: Record<TaskRevision['status'], { label: string; className: string }> = {
  pending: { label: '执行中', className: 'text-blue-700 bg-blue-500/10 dark:text-blue-300' },
  'in-progress': { label: '执行中', className: 'text-blue-700 bg-blue-500/10 dark:text-blue-300' },
  complete: { label: '已完成', className: 'text-emerald-700 bg-emerald-500/10 dark:text-emerald-300' },
  failed: { label: '失败', className: 'text-red-700 bg-red-500/10 dark:text-red-300' },
};

const revisionPushStatusDisplay: Record<TaskRevision['pushStatus'], { label: string; className: string }> = {
  local: { label: '仅本地', className: 'text-muted-foreground bg-muted' },
  held: { label: '推送已暂缓', className: 'text-amber-700 bg-amber-500/10 dark:text-amber-300' },
  pushed: { label: '已推送', className: 'text-blue-700 bg-blue-500/10 dark:text-blue-300' },
  released: { label: '已授权并推送', className: 'text-emerald-700 bg-emerald-500/10 dark:text-emerald-300' },
};

const unknownRevisionPushStatus = {
  label: '历史状态未知',
  className: 'text-muted-foreground bg-muted',
};

function getRevisionPushStatusDisplay(pushStatus: TaskRevision['pushStatus'] | null | undefined) {
  return pushStatus ? revisionPushStatusDisplay[pushStatus] : unknownRevisionPushStatus;
}

function formatRevisionTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function HeldRevisionNotice() {
  return (
    <div role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
      存在未授权推送的修改
    </div>
  );
}

function RevisionHistory({ revisions, loading, error }: {
  revisions: TaskRevision[];
  loading: boolean;
  error: string | null;
}) {
  const sortedRevisions = useMemo(
    () => [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber),
    [revisions]
  );
  const latestRevision = sortedRevisions[0];
  const [expandedRevisionIds, setExpandedRevisionIds] = useState<Set<string>>(new Set());
  const hasHeldRevisions = sortedRevisions.some((revision) => revision.pushStatus === 'held');

  useEffect(() => {
    if (!latestRevision) return;
    setExpandedRevisionIds((current) => {
      if (current.has(latestRevision.id)) return current;
      const next = new Set(current);
      next.add(latestRevision.id);
      return next;
    });
  }, [latestRevision]);

  const toggleRevision = (revisionId: string) => {
    setExpandedRevisionIds((current) => {
      const next = new Set(current);
      if (next.has(revisionId)) next.delete(revisionId);
      else next.add(revisionId);
      return next;
    });
  };

  return (
    <section aria-label="修改记录" className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-3">
      {hasHeldRevisions && <HeldRevisionNotice />}
      {loading && <p className="px-1 text-xs text-muted-foreground">正在加载…</p>}
      {!loading && error && <p role="alert" className="px-1 text-xs text-red-600 dark:text-red-400">加载失败：{error}</p>}
      {!loading && !error && revisions.length === 0 && (
        <div className="flex h-full min-h-48 items-center justify-center">
          <p className="text-sm text-muted-foreground/60">暂无修改记录</p>
        </div>
      )}
      {!loading && !error && revisions.length > 0 && (
        <ol className="space-y-2.5">
          {sortedRevisions.map((revision) => {
            const status = revisionStatusDisplay[revision.status];
            const pushStatus = getRevisionPushStatusDisplay(revision.pushStatus);
            const isLatest = revision.id === latestRevision?.id;
            const isExpanded = expandedRevisionIds.has(revision.id);
            const contentId = `revision-${revision.id}-content`;
            return (
              <li data-testid={`revision-card-${revision.revisionNumber}`} key={revision.id} className={cn(
                'overflow-hidden rounded-lg border bg-card',
                isLatest ? 'border-primary/35' : 'border-border'
              )}>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={contentId}
                  onClick={() => toggleRevision(revision.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
                >
                  {isExpanded
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs font-semibold text-foreground">第 {revision.revisionNumber} 轮</span>
                      {isLatest && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                          当前轮次
                        </span>
                      )}
                      <time className="text-[10px] text-muted-foreground" dateTime={new Date(revision.createdAt).toISOString()}>
                        {formatRevisionTime(revision.createdAt)}
                      </time>
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className={cn('rounded-full px-2 py-0.5 font-medium', status.className)}>{status.label}</span>
                      <span className={cn('rounded-full px-2 py-0.5 font-medium', pushStatus.className)}>{pushStatus.label}</span>
                      <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                        {revision.commitSha ? revision.commitSha.slice(0, 7) : '无提交'}
                      </code>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div id={contentId} className="border-t border-border px-4 py-3">
                    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                      <dt className="text-muted-foreground">Revision</dt>
                      <dd className="font-medium text-foreground">第 {revision.revisionNumber} 轮</dd>
                      <dt className="text-muted-foreground">时间</dt>
                      <dd className="text-foreground">{formatRevisionTime(revision.createdAt)}</dd>
                      <dt className="text-muted-foreground">执行状态</dt>
                      <dd><span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', status.className)}>{status.label}</span></dd>
                      <dt className="text-muted-foreground">Push 状态</dt>
                      <dd><span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', pushStatus.className)}>{pushStatus.label}</span></dd>
                      <dt className="text-muted-foreground">Commit SHA</dt>
                      <dd>
                        {revision.commitSha
                          ? <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{revision.commitSha}</code>
                          : <span className="text-muted-foreground">无提交</span>}
                      </dd>
                      {revision.pushedAt && (
                        <>
                          <dt className="text-muted-foreground">推送时间</dt>
                          <dd className="text-foreground">{formatRevisionTime(revision.pushedAt)}</dd>
                        </>
                      )}
                      {revision.releasedByRevisionId && (
                        <>
                          <dt className="text-muted-foreground">授权轮次</dt>
                          <dd><code className="break-all font-mono text-foreground">{revision.releasedByRevisionId}</code></dd>
                        </>
                      )}
                    </dl>

                    <div className="mt-4 border-t border-border pt-3">
                      <h5 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">用户修改意见</h5>
                      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground">{revision.feedback}</p>
                    </div>

                    <div className="mt-4 border-t border-border pt-3">
                      <h5 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Agent Result</h5>
                      {revision.agentSummary ? (
                        <div className="prose prose-sm dark:prose-invert mt-1.5 max-w-none text-xs text-foreground [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-xs [&_h2]:font-semibold [&_h2:first-child]:mt-0">
                          <Markdown>{revision.agentSummary}</Markdown>
                        </div>
                      ) : (
                        <p className="mt-1.5 text-xs text-muted-foreground">暂无 Agent 结果</p>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="whitespace-pre-wrap font-mono text-xs text-red-300">{message}</p>
        <button
          onClick={() => navigator.clipboard.writeText(message)}
          className="shrink-0 rounded px-2 py-1 text-[10px] text-red-400 hover:bg-red-500/20"
        >
          Copy
        </button>
      </div>
      <button
        onClick={onDismiss}
        className="mt-2 text-[10px] text-zinc-300 hover:text-white"
      >
        Dismiss
      </button>
    </div>
  );
}

function FailureSummary({ message }: { message: string }) {
  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500 dark:text-red-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-red-700 dark:text-red-300">Agent failed</p>
            <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-red-700/80 dark:text-red-300/80">
              {message}
            </p>
          </div>
          <CopyButton text={message} />
        </div>
      </div>
    </div>
  );
}
