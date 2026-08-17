import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, createTaskViaAPI, deleteTaskViaAPI, waitForBoard } from './helpers';

async function moveTask(request: APIRequestContext, taskId: string, columnId: 'in-progress' | 'review' | 'done') {
  const response = await request.patch(`${API}/api/tasks/${taskId}`, { data: { columnId } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function moveToReview(request: APIRequestContext, taskId: string) {
  await moveTask(request, taskId, 'in-progress');
  return moveTask(request, taskId, 'review');
}

async function openTaskPanel(page: Page, title: string) {
  await page.goto('/');
  await waitForBoard(page);
  await page.getByRole('heading', { name: title }).click();
  await expect(page.getByTitle('Close panel (Esc)')).toBeVisible();
}

test.describe('Review feedback workflow', () => {
  const createdTaskIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdTaskIds.splice(0)) {
      await deleteTaskViaAPI(request, id).catch(() => {});
    }
  });

  test('keeps Review actions in Summary and compares revisions in an independent tab', async ({ page, request }) => {
    const title = `Review feedback ${Date.now()}`;
    const task = await createTaskViaAPI(request, { title, description: 'Original task requirements' });
    createdTaskIds.push(task.id);
    const reviewTask = await moveToReview(request, task.id);
    const now = new Date('2026-08-11T14:14:00.000Z').getTime();
    const existingRevisions = [
      {
        id: 'revision-1',
        taskId: task.id,
        revisionNumber: 1,
        feedback: '修复移动端的按钮间距',
        status: 'complete',
        createdAt: now - 60_000,
        completedAt: now - 30_000,
        agentSummary: '## Completed\n已调整响应式间距。\n\n## Comments\n已完成视觉校对。\n\n## Remaining\n无。',
        commitSha: '1234567890abcdef',
        pushStatus: 'held',
      },
      {
        id: 'revision-2',
        taskId: task.id,
        revisionNumber: 2,
        feedback: '补充空状态说明',
        status: 'failed',
        createdAt: now - 20_000,
        agentSummary: '## Completed\n已补充文案。\n\n## Comments\n测试未通过。\n\n## Remaining\n修复失败用例。',
        pushStatus: 'local',
      },
    ];

    await page.route(`**/api/tasks/${task.id}/revisions`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(existingRevisions) });
    });

    let submittedBody: unknown;
    await page.route(`**/api/tasks/${task.id}/request-changes`, async (route) => {
      submittedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          task: { ...reviewTask, columnId: 'in-progress', agentStatus: 'planning' },
          revision: {
            id: 'revision-3',
            taskId: task.id,
            revisionNumber: 3,
            feedback: '请修复窄屏下的溢出问题',
            status: 'pending',
            createdAt: now,
            pushStatus: 'local',
          },
        }),
      });
    });

    await openTaskPanel(page, title);

    const feedbackInput = page.getByPlaceholder('填写修改意见…');
    const requestButton = page.getByRole('button', { name: '发起修改' });
    const summary = page.getByRole('region', { name: 'Summary' });
    await expect(feedbackInput).toBeVisible();
    await expect(requestButton).toBeDisabled();
    await expect(page.getByRole('button', { name: '修改记录 (2)' })).toBeVisible();
    await expect(summary).not.toContainText('第 1 轮');
    await expect(summary).not.toContainText('修复移动端的按钮间距');
    await expect(page.getByRole('region', { name: '修改记录' })).toHaveCount(0);
    await expect(page.getByText('存在未授权推送的修改', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('Send a message to the agent...')).toHaveCount(0);

    await page.getByRole('button', { name: '修改记录 (2)' }).click();
    const history = page.getByRole('region', { name: '修改记录' });
    const latestCard = page.getByTestId('revision-card-2');
    const historicalCard = page.getByTestId('revision-card-1');
    const latestToggle = latestCard.getByRole('button', { name: /第 2 轮/ });
    const historicalToggle = historicalCard.getByRole('button', { name: /第 1 轮/ });

    await expect(history).toBeVisible();
    await expect(history.locator('[data-testid^="revision-card-"]')).toHaveCount(2);
    await expect(history.locator('[data-testid^="revision-card-"]').first()).toHaveAttribute('data-testid', 'revision-card-2');
    await expect(latestToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(historicalToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(latestCard.getByText('当前轮次', { exact: true })).toBeVisible();
    await expect(latestCard).toContainText('失败');
    await expect(latestCard).toContainText('仅本地');
    await expect(latestCard).toContainText('无提交');
    await expect(latestCard.locator('time')).toHaveAttribute('datetime', new Date(now - 20_000).toISOString());
    await expect(historicalCard).toContainText('已完成');
    await expect(historicalCard).toContainText('推送已暂缓');
    await expect(historicalCard).toContainText('1234567');
    await expect(historicalCard.locator('time')).toHaveAttribute('datetime', new Date(now - 60_000).toISOString());
    await expect(historicalCard.getByText('修复移动端的按钮间距', { exact: true })).toHaveCount(0);
    await expect(page.getByText('存在未授权推送的修改', { exact: true })).toBeVisible();

    await historicalToggle.click();
    await expect(historicalToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(latestToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(historicalCard.getByText('修复移动端的按钮间距', { exact: true })).toBeVisible();
    await expect(historicalCard).toContainText('Completed');
    await expect(historicalCard).toContainText('Comments');
    await expect(historicalCard).toContainText('Remaining');
    await expect(historicalCard).toContainText('1234567890abcdef');

    await page.getByRole('button', { name: 'Summary' }).click();
    await expect(feedbackInput).toBeVisible();
    await expect(requestButton).toBeDisabled();
    await expect(page.getByRole('region', { name: '修改记录' })).toHaveCount(0);
    await expect(summary).not.toContainText('修复移动端的按钮间距');
    await expect(summary.getByText('存在未授权推送的修改', { exact: true })).toBeVisible();

    await feedbackInput.fill('  请修复窄屏下的溢出问题  ');
    await expect(requestButton).toBeEnabled();
    await requestButton.click();

    await expect.poll(() => submittedBody).toEqual({ feedback: '请修复窄屏下的溢出问题' });
    await expect(feedbackInput).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发起修改' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '修改记录 (3)' })).toBeVisible();
  });

  test('real API atomically records feedback and moves the task into a fresh run', async ({ request }) => {
    const task = await createTaskViaAPI(request, { title: `Review API ${Date.now()}` });
    createdTaskIds.push(task.id);
    await moveToReview(request, task.id);

    const response = await request.post(`${API}/api/tasks/${task.id}/request-changes`, {
      data: { feedback: '请根据本轮 Review 修复问题' },
    });
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.task.columnId).toBe('in-progress');
    expect(body.revision).toMatchObject({
      taskId: task.id,
      revisionNumber: 1,
      feedback: '请根据本轮 Review 修复问题',
      pushStatus: 'local',
    });

    const historyResponse = await request.get(`${API}/api/tasks/${task.id}/revisions`);
    expect(historyResponse.ok()).toBeTruthy();
    const history = await historyResponse.json();
    expect(history).toHaveLength(1);
    expect(history[0].feedback).toBe('请根据本轮 Review 修复问题');
  });

  test('Done is read-only while In Progress and Backlog expose no comment input', async ({ page, request }) => {
    const doneTitle = `Done revisions ${Date.now()}`;
    const doneTask = await createTaskViaAPI(request, { title: doneTitle });
    createdTaskIds.push(doneTask.id);
    await moveToReview(request, doneTask.id);
    await moveTask(request, doneTask.id, 'done');

    await page.route(`**/api/tasks/${doneTask.id}/revisions`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'done-revision',
          taskId: doneTask.id,
          revisionNumber: 1,
          feedback: '完成最终视觉校对',
          status: 'complete',
          createdAt: Date.now(),
          commitSha: 'abcdef1234567890',
          pushStatus: 'released',
          releasedByRevisionId: 'release-revision',
        }]),
      });
    });

    await openTaskPanel(page, doneTitle);
    await expect(page.getByRole('button', { name: '修改记录 (1)' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Summary' })).not.toContainText('完成最终视觉校对');
    await expect(page.getByPlaceholder('填写修改意见…')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发起修改' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Send a message to the agent...')).toHaveCount(0);
    await page.getByRole('button', { name: '修改记录 (1)' }).click();
    await expect(page.getByRole('region', { name: '修改记录' })).toContainText('完成最终视觉校对');
    await expect(page.getByTestId('revision-card-1').getByRole('button', { name: /第 1 轮/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByPlaceholder('填写修改意见…')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发起修改' })).toHaveCount(0);

    await page.getByTitle('Close panel (Esc)').click();

    const progressTitle = `Progress no comments ${Date.now()}`;
    const progressTask = await createTaskViaAPI(request, { title: progressTitle });
    createdTaskIds.push(progressTask.id);
    await moveTask(request, progressTask.id, 'in-progress');
    await page.reload();
    await waitForBoard(page);
    await page.getByRole('heading', { name: progressTitle }).click();
    await expect(page.getByPlaceholder('填写修改意见…')).toHaveCount(0);
    await expect(page.getByPlaceholder('Send a message to the agent...')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '修改记录' })).toHaveCount(0);
    await page.getByRole('button', { name: '修改记录 (0)' }).click();
    await expect(page.getByRole('region', { name: '修改记录' })).toContainText('暂无修改记录');

    await page.getByTitle('Close panel (Esc)').click();
    const backlogTitle = `Backlog no comments ${Date.now()}`;
    const backlogTask = await createTaskViaAPI(request, { title: backlogTitle });
    createdTaskIds.push(backlogTask.id);
    await page.reload();
    await waitForBoard(page);
    await expect(page.getByRole('heading', { name: backlogTitle })).toBeVisible();
    await expect(page.getByPlaceholder('填写修改意见…')).toHaveCount(0);
    await expect(page.getByPlaceholder('Send a message to the agent...')).toHaveCount(0);
  });

  test('E2E client uses the same-origin WebSocket proxy', async ({ page }) => {
    await page.goto('/');
    await waitForBoard(page);
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 5_000 });
  });
});
