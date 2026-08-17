const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { sanitizeGitEnv } = require('./sanitize-git-env.cjs');

const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const command = isWindows ? 'powershell.exe' : 'sh';
const args = isWindows
  ? [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(repoRoot, 'scripts', 'required-gate.ps1'),
    ]
  : [path.join(repoRoot, 'scripts', 'required-gate.sh')];

// Sanitize repository-local Git environment variables at the central gate
// subprocess boundary. A pre-push hook inherits GIT_DIR/GIT_WORK_TREE from the
// outer Git process; without stripping them here, downstream E2E git commands
// would ignore their explicit fixture cwd and mutate the product repository.
const result = spawnSync(command, args, {
  cwd: repoRoot,
  env: sanitizeGitEnv(process.env),
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
