import { Router, type Request, type Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { AgentManager } from '../services/agent-manager.js';
import type { TaskRepository } from '../repositories/types.js';
import { asyncHandler, broadcastTaskUpdate, paramId, startAgentForTask } from './helpers.js';

const MAX_REVIEW_FEEDBACK_LENGTH = 20_000;

/** Review feedback history and the durable transition into a fresh execution round. */
export function createRevisionsRouter(repo: TaskRepository, agentManager: AgentManager): Router {
  const router = Router();

  router.get('/:id/revisions', asyncHandler(async (req: Request, res: Response) => {
    const taskId = paramId(req);
    if (!await repo.getById(taskId)) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    res.json(await repo.getRevisionsByTaskId(taskId));
  }));

  router.post('/:id/request-changes', asyncHandler(async (req: Request, res: Response) => {
    const taskId = paramId(req);
    let task = await repo.getById(taskId);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (task.columnId !== 'review') {
      res.status(409).json({ error: 'changes can only be requested while the task is in review' });
      return;
    }
    if (agentManager.isRunning(taskId)) {
      res.status(409).json({ error: 'agent already running for this task' });
      return;
    }

    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : '';
    if (!feedback) {
      res.status(400).json({ error: 'feedback is required and must be a non-empty string' });
      return;
    }
    if (feedback.length > MAX_REVIEW_FEEDBACK_LENGTH) {
      res.status(400).json({ error: `feedback must be at most ${MAX_REVIEW_FEEDBACK_LENGTH} characters` });
      return;
    }

    // Older tasks predate prUrl persistence. Discover an already-open PR before
    // building the revision prompt so only the existing branch may be pushed.
    if (!task.prUrl) {
      const discoveredPrUrl = agentManager.findOpenPullRequest(task);
      if (discoveredPrUrl) {
        const updated = await repo.update(taskId, { prUrl: discoveredPrUrl });
        if (updated) {
          task = updated;
          broadcastTaskUpdate(updated);
        }
      }
    }
    const startedAt = Date.now();
    const begun = await repo.beginRevision({
      id: uuid(),
      taskId,
      feedback,
      createdAt: startedAt,
    });
    if (!begun) {
      // The transaction re-checks the state, so concurrent submissions cannot create two active rounds.
      res.status(409).json({ error: 'task is no longer available for review changes' });
      return;
    }

    broadcastTaskUpdate(begun.task);
    agentManager.resetEvents(taskId);
    await startAgentForTask(begun.task, repo, agentManager);
    res.status(201).json(begun);
  }));

  return router;
}
