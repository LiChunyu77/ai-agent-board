import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import {
  cleanupTestPath,
  getTestRepoPath,
  prepareTestRepo,
} from './helpers';

const productRepoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();

const sanitizeModulePath = path.join(productRepoRoot, 'scripts', 'sanitize-git-env.cjs');

function snapshotRepo(repoPath: string) {
  return {
    config: execFileSync('git', ['config', '--local', '--list'], {
      cwd: repoPath,
      encoding: 'utf8',
    }),
    refs: execFileSync('git', ['show-ref'], {
      cwd: repoPath,
      encoding: 'utf8',
    }),
  };
}

function loadSanitizer() {
  const require = createRequire(import.meta.url);
  return require(sanitizeModulePath) as {
    getGitLocalEnvVars: () => Set<string> | string[];
    sanitizeGitEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  };
}

test.describe('gate hostile-environment contract', () => {
  const protectedRepo = getTestRepoPath('sentinel-protected');
  const workRepo = getTestRepoPath('sentinel-work');

  test.beforeAll(() => {
    cleanupTestPath(protectedRepo);
    cleanupTestPath(workRepo);
    prepareTestRepo('sentinel-protected', { clean: true });
    prepareTestRepo('sentinel-work', { clean: true });
  });

  test.afterAll(() => {
    cleanupTestPath(protectedRepo);
    cleanupTestPath(workRepo);
  });

  test('sanitizeGitEnv removes all repository-local Git env vars', () => {
    const { getGitLocalEnvVars, sanitizeGitEnv } = loadSanitizer();
    const localVars = Array.from(getGitLocalEnvVars());
    expect(localVars).toContain('GIT_DIR');
    expect(localVars).toContain('GIT_PREFIX');

    const hostile: NodeJS.ProcessEnv = { ...process.env };
    for (const name of localVars) {
      hostile[name] = 'hostile-value';
    }

    const sanitized = sanitizeGitEnv(hostile);
    for (const name of localVars) {
      expect(sanitized).not.toHaveProperty(name);
    }

    // Non-Git environment is preserved.
    expect(sanitized.PATH).toBe(process.env.PATH);
  });

  test('sanitized child git commands honor explicit fixture cwd and leave sentinel repo unchanged', () => {
    const { sanitizeGitEnv } = loadSanitizer();

    const beforeProtected = snapshotRepo(protectedRepo);

    const hostile: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: path.join(protectedRepo, '.git'),
      GIT_WORK_TREE: protectedRepo,
      GIT_PREFIX: '',
    };

    const sanitized = sanitizeGitEnv(hostile);

    // Without sanitization the outer Git repository context leaks in.
    const unsafeTop = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workRepo,
      env: hostile,
      encoding: 'utf8',
    }).trim();
    expect(unsafeTop).toBe(protectedRepo);

    // With sanitization git resolves its repo from the explicit cwd.
    const safeTop = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workRepo,
      env: sanitized,
      encoding: 'utf8',
    }).trim();
    expect(safeTop).toBe(workRepo);

    // A mutating command with sanitized env touches only the work repo.
    execFileSync('git', ['config', 'user.name', 'Sanitized Child'], {
      cwd: workRepo,
      env: sanitized,
    });
    execFileSync('git', ['config', 'user.email', 'sanitized@example.com'], {
      cwd: workRepo,
      env: sanitized,
    });

    const workConfig = execFileSync('git', ['config', '--local', '--list'], {
      cwd: workRepo,
      env: sanitized,
      encoding: 'utf8',
    });
    expect(workConfig).toContain('sanitized@example.com');

    const afterProtected = snapshotRepo(protectedRepo);
    expect(afterProtected.config).toBe(beforeProtected.config);
    expect(afterProtected.refs).toBe(beforeProtected.refs);
  });

  test('run-required-gate strips hostile Git env before spawning children', () => {
    const isWindows = process.platform === 'win32';
    const fakeBinDir = getTestRepoPath(isWindows ? 'fake-powershell-bin' : 'fake-sh-bin');
    cleanupTestPath(fakeBinDir);
    mkdirSync(fakeBinDir, { recursive: true });

    let probeCommand: string;
    if (isWindows) {
      probeCommand = path.join(fakeBinDir, 'powershell.exe.bat');
      writeFileSync(
        probeCommand,
        '@echo off\r\nnode -e "console.log(JSON.stringify(process.env))"\r\nexit 0\r\n',
      );
    } else {
      probeCommand = path.join(fakeBinDir, 'sh');
      writeFileSync(
        probeCommand,
        '#!/bin/sh\nnode -e \'console.log(JSON.stringify(process.env))\'\nexit 0\n',
        { mode: 0o755 },
      );
    }

    const pathSeparator = isWindows ? ';' : ':';
    const hostile: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: path.join(protectedRepo, '.git'),
      GIT_WORK_TREE: protectedRepo,
      GIT_PREFIX: '',
      GIT_INDEX_FILE: path.join(protectedRepo, '.git', 'index'),
      PATH: `${fakeBinDir}${pathSeparator}${process.env.PATH ?? ''}`,
    };

    const result = spawnSync(
      process.execPath,
      [path.join(productRepoRoot, 'scripts', 'run-required-gate.cjs')],
      {
        cwd: productRepoRoot,
        env: hostile,
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.error).toBeFalsy();

    const childEnv = JSON.parse(result.stdout.trim());
    expect(childEnv.GIT_DIR).toBeUndefined();
    expect(childEnv.GIT_WORK_TREE).toBeUndefined();
    expect(childEnv.GIT_PREFIX).toBeUndefined();

    const { getGitLocalEnvVars } = loadSanitizer();
    for (const name of getGitLocalEnvVars()) {
      expect(childEnv).not.toHaveProperty(name);
    }

    cleanupTestPath(fakeBinDir);
  });
});
