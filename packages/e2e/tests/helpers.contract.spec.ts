import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import {
  assertInsideFixtureRoot,
  cleanupTestPath,
  createGhStub,
  E2E_TEST_REPO_ROOT,
  getFixtureRoot,
  getTestRepoPath,
  git,
  prepareBareRemote,
  prepareTestRepo,
} from './helpers';

const productRepoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();

test.describe('helpers fail-closed contract', () => {
  test('assertInsideFixtureRoot accepts strict descendants', () => {
    expect(() => assertInsideFixtureRoot(path.join(E2E_TEST_REPO_ROOT, 'nested'))).not.toThrow();
    expect(() => assertInsideFixtureRoot(path.join(E2E_TEST_REPO_ROOT, 'a', 'b'))).not.toThrow();
  });

  test('assertInsideFixtureRoot rejects the fixture root itself', () => {
    expect(() => assertInsideFixtureRoot(E2E_TEST_REPO_ROOT)).toThrow(/fixture root/);
  });

  test('assertInsideFixtureRoot rejects paths outside the fixture root', () => {
    expect(() => assertInsideFixtureRoot('/')).toThrow(/fixture root/);
    expect(() => assertInsideFixtureRoot(productRepoRoot)).toThrow(/fixture root/);
    expect(() => assertInsideFixtureRoot(path.resolve(E2E_TEST_REPO_ROOT, '..', 'escape'))).toThrow(/fixture root/);
  });

  test('getFixtureRoot rejects relative env input', () => {
    expect(() => getFixtureRoot('relative/path')).toThrow(/absolute path/);
    expect(() => getFixtureRoot('./test-results')).toThrow(/absolute path/);
    expect(() => getFixtureRoot('../test-results')).toThrow(/absolute path/);
  });

  test('getFixtureRoot rejects fixture-root equality with the product repository', () => {
    expect(() => getFixtureRoot(productRepoRoot)).toThrow(/must not be the product repository root/);
  });

  test('createGhStub rejects malicious E2E_GH_STUB_DIR outside fixture root without deleting', () => {
    const outside = path.resolve(E2E_TEST_REPO_ROOT, '..', `malicious-gh-stub-${Date.now()}`);
    expect(existsSync(outside)).toBe(false);
    expect(() => createGhStub(outside)).toThrow(/fixture root/);
    expect(existsSync(outside)).toBe(false);
  });

  test('createGhStub rejects malicious E2E_GH_STUB_LOG outside fixture root without deleting', () => {
    const validStub = path.join(E2E_TEST_REPO_ROOT, 'gh-stub-contract');
    const outsideLog = path.resolve(E2E_TEST_REPO_ROOT, '..', `malicious-gh-stub-${Date.now()}.log`);
    expect(existsSync(outsideLog)).toBe(false);
    expect(() => createGhStub(validStub, outsideLog)).toThrow(/fixture root/);
    expect(existsSync(outsideLog)).toBe(false);
  });

  test('createGhStub accepts paths strictly inside fixture root', () => {
    const stubDir = createGhStub();
    expect(stubDir.startsWith(E2E_TEST_REPO_ROOT + path.sep)).toBe(true);
    expect(stubDir).not.toBe(E2E_TEST_REPO_ROOT);
    cleanupTestPath(stubDir);
  });

  test('git refuses to operate outside the fixture root', () => {
    expect(() => git(['status'], productRepoRoot)).toThrow(/fixture root/);
    expect(() => git(['status'], '/')).toThrow(/fixture root/);
  });

  test('cleanupTestPath refuses to operate outside the fixture root', () => {
    expect(() => cleanupTestPath(productRepoRoot)).toThrow(/fixture root/);
    expect(() => cleanupTestPath('/')).toThrow(/fixture root/);
    expect(() => cleanupTestPath(E2E_TEST_REPO_ROOT)).toThrow(/fixture root/);
  });

  test('prepareBareRemote aborts when source fixture repo is missing', () => {
    const missingSource = getTestRepoPath(`definitely-missing-source-${Date.now()}`);
    expect(existsSync(missingSource)).toBe(false);
    expect(() => prepareBareRemote('from-missing', missingSource)).toThrow();
  });

  test('fixture setup failure does not fall back to cwd or product repo', () => {
    // getTestRepoPath always produces a path under the fixture root, even for
    // a name that looks like an escape attempt. prepareTestRepo then confines
    // all mutation to that path.
    const suspiciousName = '../escape-attempt';
    const repoPath = getTestRepoPath(suspiciousName);
    expect(repoPath.startsWith(E2E_TEST_REPO_ROOT + path.sep)).toBe(true);

    prepareTestRepo(suspiciousName, { clean: true });
    expect(existsSync(repoPath)).toBe(true);

    // Verify the parent of the fixture root was never touched.
    const fixtureParent = path.resolve(E2E_TEST_REPO_ROOT, '..');
    expect(path.dirname(repoPath)).not.toBe(fixtureParent);

    cleanupTestPath(repoPath);
  });
});
