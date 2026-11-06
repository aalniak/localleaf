// Setup assistant logic: find a LaTeX compiler, and offer to install/start Docker.
// Everything OS- or IO-specific is injected so the flow is unit-testable; see setup.js.
import fs from 'node:fs';
import path from 'node:path';
import { windowsDockerDesktopDirs } from '../server/compiler/dockerPath.js';

const DOCS = {
  win32: 'https://docs.docker.com/desktop/setup/install/windows-install/',
  darwin: 'https://docs.docker.com/desktop/setup/install/mac-install/',
  linux: 'https://docs.docker.com/engine/install/',
};
const docsUrl = (platform) => DOCS[platform] ?? 'https://docs.docker.com/get-started/get-docker/';

const ALTERNATIVES = [
  'Without Docker you can still edit projects, but not compile them. Alternatives:',
  '  - install TeX Live (https://tug.org/texlive/) or MiKTeX (https://miktex.org/), which provide latexmk, or',
  '  - install Tectonic (https://tectonic-typesetting.github.io/).',
  'Run "npm run setup" any time to come back to this.',
];

/**
 * How to install Docker on this OS with the tools available.
 * @returns {{ commands: [string, string[]][], url: string, notes: string[], startAfterInstall: boolean, runsRemoteScriptAsRoot: boolean }}
 */
export function installPlan(platform, tools) {
  const base = { url: docsUrl(platform), commands: [], notes: [], startAfterInstall: true, runsRemoteScriptAsRoot: false };
  if (platform === 'win32' && tools.winget) {
    return {
      ...base,
      commands: [['winget', ['install', '-e', '--id', 'Docker.DockerDesktop', '--accept-package-agreements', '--accept-source-agreements']]],
      notes: ['Docker Desktop may ask you to enable WSL 2 or restart Windows. If it does, do that, then run "npm start" again.'],
    };
  }
  if (platform === 'darwin' && tools.brew) {
    return { ...base, commands: [['brew', ['install', '--cask', 'docker']]] };
  }
  if (platform === 'linux' && tools.curl) {
    return {
      ...base,
      commands: [['sh', ['-c', 'curl -fsSL https://get.docker.com | sudo sh']]],
      notes: [
        'Next: sudo systemctl enable --now docker',
        'and, to use Docker without sudo: sudo usermod -aG docker $USER, then log out and back in.',
        'Localleaf picks Docker up automatically after that.',
      ],
      // The new group membership only applies after logging in again, so waiting here would just time out.
      startAfterInstall: false,
      runsRemoteScriptAsRoot: true,
    };
  }
  return base;
}

/** Command that starts the Docker daemon / Docker Desktop, or null if unknown. */
export function startPlan(platform, { env = {}, exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    const candidates = windowsDockerDesktopDirs(env).map((d) => path.win32.join(d, 'Docker Desktop.exe'));
    return ['cmd', ['/c', 'start', '', candidates.find((p) => exists(p)) ?? candidates.at(-1)]];
  }
  if (platform === 'darwin') return ['open', ['-a', 'Docker']];
  if (platform === 'linux') return ['sudo', ['systemctl', 'start', 'docker']];
  return null;
}

/** Poll `check` until it resolves true or `timeoutMs` passes. */
export async function waitFor(check, { timeoutMs, intervalMs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

async function confirm(prompt, question, defaultYes) {
  const answer = (await prompt(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return answer === '' ? defaultYes : answer.startsWith('y');
}

/** Start Docker and wait for its daemon. */
async function startDocker(deps) {
  const { platform, env, probe, exec, log, wait } = deps;
  const cmd = startPlan(platform, { env, exists: deps.exists });
  if (!cmd) {
    log('Start Docker manually, then run "npm start" again.');
    return 'skipped';
  }
  await exec(cmd[0], cmd[1]);
  log('Waiting for Docker to start (the first start can take a few minutes)...');
  if (await wait(async () => (await probe()).dockerRunning)) {
    log('Docker is running. The first compile downloads TeX Live (~5 GB, once).');
    return 'ready';
  }
  pendingHint(platform).forEach((l) => log(l));
  return 'pending';
}

function pendingHint(platform) {
  const tail = 'Localleaf picks Docker up automatically once it runs, no restart needed.';
  if (platform === 'linux') {
    return ['Docker is not answering yet. Check "sudo systemctl status docker", and that you are in the', `"docker" group (sudo usermod -aG docker $USER, then log out and back in). ${tail}`];
  }
  return ["Docker is not answering yet. Finish Docker Desktop's first-run steps (accept the terms; on Windows it", `may ask for WSL 2 or a restart). ${tail}`];
}

async function installDocker(deps, plan) {
  const { prompt, exec, log } = deps;
  for (const [cmd, args] of plan.commands) {
    log(`> ${cmd} ${args.join(' ')}`);
    const code = await exec(cmd, args);
    if (code !== 0) {
      log(`Installing Docker failed (exit code ${code}). Install it manually from ${plan.url}`);
      return 'failed';
    }
  }
  plan.notes.forEach((n) => log(n));
  if (!plan.startAfterInstall) return 'pending';
  if (!(await confirm(prompt, 'Docker is installed. Start it now?', true))) return 'skipped';
  return startDocker(deps);
}

/** Offer to install Docker; the exact command is shown before asking. */
async function offerInstall(deps, state, otherTex) {
  const { platform, prompt, log } = deps;
  const plan = installPlan(platform, state);
  log('Localleaf compiles with a LaTeX toolchain. The recommended one is full TeX Live in Docker (same as Overleaf).');
  if (otherTex) log(`Found a local ${state.latexmk ? 'latexmk' : 'tectonic'}, so Docker is optional.`);
  if (!plan.commands.length) {
    log(`Automatic installation isn't available here. Download Docker from ${plan.url}`);
    log('then run "npm start" again.');
    return otherTex ? 'ready' : 'skipped';
  }
  log('This would run:');
  plan.commands.forEach(([cmd, args]) => log(`  ${cmd} ${args.join(' ')}`));
  const defaultYes = !otherTex && !plan.runsRemoteScriptAsRoot;
  if (!(await confirm(prompt, 'Install Docker now?', defaultYes))) {
    if (!otherTex) ALTERNATIVES.forEach((l) => log(l));
    return otherTex ? 'ready' : 'skipped';
  }
  const result = await installDocker(deps, plan);
  return otherTex && result !== 'ready' ? 'ready' : result;
}

/**
 * Make sure a LaTeX compiler is available.
 * mode "preflight" (before npm start): silent when any compiler exists; asks only if none.
 * mode "full" (npm run setup): also offers Docker when only a local TeX is installed.
 * @returns {Promise<'ready'|'missing'|'skipped'|'failed'|'pending'>}
 */
export async function runSetup(deps) {
  const { mode, env, interactive, probe, prompt, log } = deps;
  const compiler = (env.LOCALLEAF_COMPILER ?? 'auto').toLowerCase();
  if (mode === 'preflight' && (env.LOCALLEAF_SKIP_SETUP === '1' || compiler !== 'auto')) return 'skipped';

  const state = await probe();
  const otherTex = state.latexmk || state.tectonic;
  if (state.dockerRunning) {
    if (mode === 'full') log('Docker is running. Localleaf will compile with full TeX Live. Nothing to do.');
    return 'ready';
  }
  if (mode === 'preflight' && otherTex) return 'ready';
  if (state.docker && state.dockerNoPermission) {
    log('Docker is installed, but this user may not use it. Run: sudo usermod -aG docker $USER');
    log('then log out and back in. Localleaf picks Docker up automatically after that.');
    return otherTex ? 'ready' : 'pending';
  }
  if (!interactive) {
    log('No LaTeX compiler found. Run "npm run setup" to install Docker (recommended), or install TeX Live / MiKTeX.');
    return otherTex ? 'ready' : 'missing';
  }

  if (state.docker) {
    if (await confirm(prompt, 'Docker is installed but not running. Start Docker now?', true)) return startDocker(deps);
    if (!otherTex) ALTERNATIVES.forEach((l) => log(l));
    return otherTex ? 'ready' : 'skipped';
  }
  return offerInstall(deps, state, otherTex);
}
