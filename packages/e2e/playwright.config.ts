import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';
import { createGhStub } from './tests/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use separate ports for E2E tests so they don't collide with
// the dev server (3001/4175) running in the background.
const TEST_SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 3002);
const TEST_CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 4176);

// All test repos, remotes, and the stubbed gh live under this fixture root.
// The value is exported from helpers.ts and shared with the E2E server via env.
process.env.E2E_TEST_REPO_ROOT ??= path.resolve(__dirname, 'test-results');

const E2E_TEST_REPO_ROOT = process.env.E2E_TEST_REPO_ROOT;

const ghStubDir = createGhStub();
process.env.E2E_GH_STUB_DIR = ghStubDir;
process.env.E2E_GH_STUB_LOG = path.join(ghStubDir, 'invocations.log');

// Prepend the stubbed gh to PATH so both the test process and the webServer
// child use it instead of any real GitHub CLI that may be installed.
const pathSeparator = process.platform === 'win32' ? ';' : ':';
process.env.PATH = `${ghStubDir}${pathSeparator}${process.env.PATH ?? ''}`;

// Isolate gh configuration so E2E cannot inherit stored GitHub credentials.
process.env.GH_CONFIG_DIR = path.resolve(__dirname, 'test-results', 'gh-config');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${TEST_CLIENT_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node ../../scripts/e2e-server.cjs',
      port: TEST_SERVER_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        E2E_TEST_REPO_ROOT,
        E2E_GH_STUB_DIR: ghStubDir,
        E2E_GH_STUB_LOG: process.env.E2E_GH_STUB_LOG,
        PATH: process.env.PATH,
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      },
    },
    {
      command: 'node ../../scripts/e2e-client.cjs',
      port: TEST_CLIENT_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
