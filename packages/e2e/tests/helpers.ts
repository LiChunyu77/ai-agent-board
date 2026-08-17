import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

const TEST_SERVER_PORT = process.env.E2E_SERVER_PORT ?? '3002';
export const API = `http://localhost:${TEST_SERVER_PORT}`;
const DEFAULT_TEST_REPO_NAME = 'test-repo';

const E2E_TEST_IDENTITY = { name: 'E2E Test', email: 'test@test.com' };

export const E2E_TEST_REPO_ROOT = getFixtureRoot();
export const E2E_GH_STUB_DIR = process.env.E2E_GH_STUB_DIR
  ? path.resolve(process.env.E2E_GH_STUB_DIR)
  : path.resolve(process.cwd(), 'test-results', 'gh-stub');
export const E2E_GH_STUB_LOG = process.env.E2E_GH_STUB_LOG
  ? path.resolve(process.env.E2E_GH_STUB_LOG)
  : path.resolve(process.cwd(), 'test-results', 'gh-stub', 'invocations.log');

/**
 * Return the absolute fixture root used for all E2E repositories and remotes.
 * Defaults to `<cwd>/test-results` but can be overridden with
 * E2E_TEST_REPO_ROOT. Throws if the raw env value is relative, the resolved
 * path is not absolute, or it equals the product repository root.
 */
export function getFixtureRoot(raw = process.env.E2E_TEST_REPO_ROOT): string {
  if (raw && !path.isAbsolute(raw)) {
    throw new Error(`E2E_TEST_REPO_ROOT must be an absolute path: ${raw}`);
  }
  const root = raw ? path.resolve(raw) : path.resolve(process.cwd(), 'test-results');
  if (!path.isAbsolute(root)) {
    throw new Error(`E2E fixture root must be an absolute path: ${root}`);
  }
  // Detect accidental targeting of the product repo root by comparing with the
  // git worktree root of the current process.
  let productRepoRoot: string | undefined;
  try {
    productRepoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch {
    // Not inside a git repo; no product root to guard against.
  }
  if (productRepoRoot && normalizeForCompare(root) === normalizeForCompare(productRepoRoot)) {
    throw new Error(
      `E2E fixture root must not be the product repository root (${productRepoRoot}). ` +
      'Set E2E_TEST_REPO_ROOT to a dedicated temporary/fixture directory.',
    );
  }
  return root;
}

function normalizeForCompare(p: string): string {
  const normalized = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Throw if `candidate` is not a strict descendant of the E2E fixture root.
 * Equality with the fixture root is also rejected so callers cannot delete or
 * mutate the fixture root itself.
 */
export function assertInsideFixtureRoot(candidate: string): void {
  const resolved = path.resolve(candidate);
  const root = path.resolve(E2E_TEST_REPO_ROOT);
  const relative = path.relative(root, resolved);
  const escapes =
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`);
  if (escapes) {
    throw new Error(
      `Refusing to operate on path outside E2E fixture root.\n` +
      `  path: ${resolved}\n` +
      `  fixture root: ${root}`,
    );
  }
}

/**
 * Create the stubbed `gh` executable directory and a log file.
 * Returns the directory that must be prepended to PATH.
 *
 * The stub intercepts `gh pr create` and returns a deterministic synthetic PR
 * URL. All other `gh` invocations exit 1 with a safe error so E2E tests cannot
 * contact GitHub or leak stored credentials.
 */
export function createGhStub(
  rawStubDir = process.env.E2E_GH_STUB_DIR,
  rawLogPath = process.env.E2E_GH_STUB_LOG,
): string {
  if (rawStubDir && !path.isAbsolute(rawStubDir)) {
    throw new Error(`E2E_GH_STUB_DIR must be an absolute path: ${rawStubDir}`);
  }
  if (rawLogPath && !path.isAbsolute(rawLogPath)) {
    throw new Error(`E2E_GH_STUB_LOG must be an absolute path: ${rawLogPath}`);
  }
  const stubDir = path.resolve(rawStubDir ?? path.join(E2E_TEST_REPO_ROOT, 'gh-stub'));
  const logPath = path.resolve(rawLogPath ?? path.join(stubDir, 'invocations.log'));

  // Fail closed before any filesystem mutation: the stub directory and its log
  // must live strictly inside the fixture root.
  assertInsideFixtureRoot(stubDir);
  assertInsideFixtureRoot(logPath);

  const isWindows = process.platform === 'win32';
  rmSync(stubDir, { recursive: true, force: true });
  mkdirSync(stubDir, { recursive: true });
  rmSync(logPath, { force: true });

  const nodeScript = path.join(stubDir, 'gh-stub.cjs');
  writeFileSync(
    nodeScript,
    `#!/usr/bin/env node\nconst fs = require('fs');\nconst log = process.env.E2E_GH_STUB_LOG;\nif (log) {\n  fs.appendFileSync(log, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');\n}\nconst args = process.argv.slice(2);\nconst prCreateIdx = args.findIndex((a, i) => a === 'pr' && args[i + 1] === 'create');\nif (prCreateIdx !== -1) {\n  const baseIdx = args.indexOf('--base', prCreateIdx);\n  const headIdx = args.indexOf('--head', prCreateIdx);\n  const base = baseIdx !== -1 ? args[baseIdx + 1] : 'main';\n  const head = headIdx !== -1 ? args[headIdx + 1] : 'feature';\n  console.log(\`https://github.com/example/agentboard-e2e/pull/\${Date.now()}\`);\n  process.exit(0);\n}\nconsole.error('gh stub: command not allowed in E2E');\nprocess.exit(1);\n`,
    { mode: 0o755 },
  );

  if (isWindows) {
    writeFileSync(
      path.join(stubDir, 'gh.cmd'),
      `@echo off\nnode "${nodeScript.replace(/"/g, '\\"')}" %*\n`,
    );
  } else {
    const wrapper = path.join(stubDir, 'gh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec node "${nodeScript}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  return stubDir;
}

type PrepareRepoOptions = {
  branch?: string;
  clean?: boolean;
  files?: Record<string, string>;
};

const preparedRepos = new Set<string>();

function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || DEFAULT_TEST_REPO_NAME;
}

/** Run git without shell interpolation so paths with spaces work on every platform. */
export function git(args: string[], cwd: string): string {
  if (!cwd || typeof cwd !== 'string') {
    throw new Error('git() requires an explicit cwd');
  }
  assertInsideFixtureRoot(cwd);
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

export function getTestRepoPath(name = DEFAULT_TEST_REPO_NAME): string {
  return path.join(E2E_TEST_REPO_ROOT, sanitizeRepoName(name));
}

function isGitRepo(repoPath: string): boolean {
  if (!existsSync(repoPath)) return false;
  try {
    git(['rev-parse', '--is-inside-work-tree'], repoPath);
    return true;
  } catch {
    return false;
  }
}

/** Prepare a deterministic, valid git repo for tests that need a local path. */
export function prepareTestRepo(name = DEFAULT_TEST_REPO_NAME, options: PrepareRepoOptions = {}): string {
  const repoPath = getTestRepoPath(name);
  assertInsideFixtureRoot(repoPath);
  const branch = options.branch ?? 'main';
  const files = options.files ?? {
    'README.md': '# E2E Test Repo\n\nRepository prepared by Playwright tests.\n',
  };
  const needsInit = options.clean || !preparedRepos.has(repoPath) || !isGitRepo(repoPath);

  if (!needsInit) return repoPath;

  rmSync(repoPath, { recursive: true, force: true });
  mkdirSync(repoPath, { recursive: true });

  try {
    git(['init', '-b', branch], repoPath);
  } catch {
    git(['init'], repoPath);
    git(['checkout', '-b', branch], repoPath);
  }

  git(['config', 'user.email', E2E_TEST_IDENTITY.email], repoPath);
  git(['config', 'user.name', E2E_TEST_IDENTITY.name], repoPath);

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  git(['add', '.'], repoPath);
  git(['commit', '--allow-empty', '-m', 'init'], repoPath);
  preparedRepos.add(repoPath);
  return repoPath;
}

/**
 * Create a temporary bare remote inside the fixture root for push/PR tests.
 * Returns the absolute path to the bare repo.
 */
export function prepareBareRemote(name: string, sourceRepo: string): string {
  const remoteRoot = getTestRepoPath('remotes');
  const bareRemote = path.join(remoteRoot, `${sanitizeRepoName(name)}-${Date.now()}.git`);
  assertInsideFixtureRoot(bareRemote);
  assertInsideFixtureRoot(sourceRepo);
  mkdirSync(remoteRoot, { recursive: true });
  git(['clone', '--bare', sourceRepo, bareRemote], remoteRoot);
  return bareRemote;
}

export function cleanupTestPath(targetPath: string): void {
  assertInsideFixtureRoot(targetPath);
  rmSync(targetPath, { recursive: true, force: true });
}

export async function fillLocalPath(page: Page, repoPath = prepareTestRepo()): Promise<string> {
  await page.getByLabel(/Local Path/i).fill(repoPath);
  return repoPath;
}

/** Wait for the board to render all four column headings. */
export async function waitForBoard(page: Page) {
  await expect(page.getByRole('heading', { name: 'Backlog', exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'In Progress', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Done', exact: true })).toBeVisible();
}

/** Create a task via the REST API. Returns the parsed JSON response. */
export async function createTaskViaAPI(request: any, overrides: Record<string, any> = {}): Promise<any> {
  const res = await request.post(`${API}/api/tasks`, {
    data: {
      title: overrides.title || 'Test Task',
      description: 'Test',
      columnId: overrides.columnId || 'backlog',
      ...overrides,
    },
  });
  return res.json();
}

/** Delete a task by ID via the REST API (cleanup). */
export async function deleteTaskViaAPI(request: any, id: string): Promise<void> {
  await request.delete(`${API}/api/tasks/${id}`);
}

/** Capture the current local Git config (excluding any mutable timestamps). */
export function snapshotGitConfig(repoPath: string): Record<string, string> {
  const out = git(['config', '--local', '--list'], repoPath);
  const config: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    // Skip ref-tracking entries created by git push -u; they are expected to
    // change in fixture repos and are not part of the base config contract.
    if (key.startsWith('branch.')) continue;
    config[key] = value;
  }
  return config;
}

/** Capture sorted local refs (branches, tags, remotes) for comparison. */
export function snapshotGitRefs(repoPath: string): string {
  return git(['show-ref'], repoPath);
}
