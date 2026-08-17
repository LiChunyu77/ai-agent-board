'use strict';

const { execFileSync } = require('node:child_process');

// Hook-only Git context that is not included in `git rev-parse --local-env-vars`
// but still forces child git commands to operate on the outer repository.
const EXTRA_REPO_LOCAL_VARS = new Set(['GIT_PREFIX']);

/**
 * Return the set of repository-local Git environment variable names.
 *
 * The authoritative list comes from `git rev-parse --local-env-vars`. If Git is
 * unavailable, fall back to a conservative hard-coded set so the sanitizer never
 * fails open.
 */
function getGitLocalEnvVars() {
  const vars = new Set(EXTRA_REPO_LOCAL_VARS);
  try {
    const output = execFileSync('git', ['rev-parse', '--local-env-vars'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of output.split(/\r?\n/)) {
      const name = line.trim();
      if (name) vars.add(name);
    }
  } catch {
    // Fail closed with the minimal set known to leak repository context.
    [
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_COMMON_DIR',
      'GIT_CONFIG',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
      'GIT_DIR',
      'GIT_GRAFT_FILE',
      'GIT_IMPLICIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_NO_REPLACE_OBJECTS',
      'GIT_OBJECT_DIRECTORY',
      'GIT_PREFIX',
      'GIT_REPLACE_REF_BASE',
      'GIT_SHALLOW_FILE',
      'GIT_WORK_TREE',
    ].forEach((name) => vars.add(name));
  }
  return vars;
}

/**
 * Return a copy of `env` with repository-local Git environment variables
 * removed. This prevents a Git hook or other outer process from forcing child
 * `git` invocations to ignore their explicit cwd and operate on the product
 * repository instead.
 */
function sanitizeGitEnv(env = process.env) {
  const repoLocalVars = getGitLocalEnvVars();
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (repoLocalVars.has(key)) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

module.exports = { getGitLocalEnvVars, sanitizeGitEnv };
