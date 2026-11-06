// Setup assistant: checks for a LaTeX compiler and offers to install/start Docker.
//   npm run setup               full check (also offers Docker when only a local TeX exists)
//   node scripts/setup.js --preflight   run automatically by "npm start"; silent if a compiler exists
// Set LOCALLEAF_SKIP_SETUP=1 to skip the preflight.
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { commandExists, run } from '../server/compiler/exec.js';
import { ensureDockerOnPath } from '../server/compiler/dockerPath.js';
import { runSetup, waitFor } from './setupLib.js';

const MIN_NODE = [22, 12];

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return true;
  console.error(`[setup] Localleaf needs Node.js ${MIN_NODE.join('.')} or newer (you have ${process.versions.node}). Get it from https://nodejs.org/`);
  return false;
}

async function probe() {
  ensureDockerOnPath(); // a Docker installed during this run is not on the old PATH yet
  const [docker, latexmk, tectonic, winget, brew, curl] = await Promise.all([
    commandExists('docker', ['--version']),
    commandExists('latexmk', ['-v']),
    commandExists('tectonic', ['--version']),
    process.platform === 'win32' ? commandExists('winget', ['--version']) : false,
    process.platform === 'darwin' ? commandExists('brew', ['--version']) : false,
    process.platform === 'linux' ? commandExists('curl', ['--version']) : false,
  ]);
  const info = docker ? await dockerInfo() : { running: false, noPermission: false };
  return { docker, dockerRunning: info.running, dockerNoPermission: info.noPermission, latexmk, tectonic, winget, brew, curl };
}

async function dockerInfo() {
  try {
    const { code, stderr } = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15000 });
    return { running: code === 0, noPermission: code !== 0 && /permission denied/i.test(stderr) };
  } catch {
    return { running: false, noPermission: false };
  }
}

/** Ask a question; Ctrl+D / Ctrl+C / closed stdin count as an empty answer (the safe default). */
function ask(rl, question) {
  return new Promise((resolve) => {
    const onClose = () => resolve('');
    rl.once('close', onClose);
    rl.question(question).then(
      (answer) => { rl.off('close', onClose); resolve(answer); },
      () => resolve(''),
    );
  });
}

/** Run a command attached to this terminal (installers may ask for a password or UAC). */
function exec(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[setup] could not run ${cmd}: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const mode = process.argv.includes('--preflight') ? 'preflight' : 'full';
  if (!checkNode()) {
    if (mode === 'full') process.exit(1);
    return; // the build/server will report the problem; never fail "npm start" here
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  rl?.on('SIGINT', () => rl.close());
  try {
    const result = await runSetup({
      mode,
      platform: process.platform,
      env: process.env,
      interactive,
      probe,
      exec,
      prompt: (q) => ask(rl, `[setup] ${q}`),
      log: (m) => console.log(`[setup] ${m}`),
      wait: (check) => waitFor(check, { timeoutMs: 4 * 60 * 1000, intervalMs: 3000 }),
    });
    if (mode === 'full' && result === 'ready') console.log('[setup] All set. Start Localleaf with "npm start".');
  } finally {
    rl?.close();
  }
}

// The preflight must never block "npm start": the editor works without a compiler.
main().catch((err) => {
  console.error(`[setup] ${err.message}`);
  if (!process.argv.includes('--preflight')) process.exit(1);
});
