// Setup assistant (scripts/setupLib.js) and runtime compiler re-detection.
import { describe, it, expect, vi } from 'vitest';
import { installPlan, startPlan, runSetup, waitFor } from '../scripts/setupLib.js';
import { createRedetectingBackend } from '../server/compiler/detect.js';

const tools = (over = {}) => ({ winget: false, brew: false, curl: false, ...over });

describe('installPlan', () => {
  it('uses winget on Windows', () => {
    const plan = installPlan('win32', tools({ winget: true }));
    expect(plan.commands).toEqual([['winget', ['install', '-e', '--id', 'Docker.DockerDesktop', '--accept-package-agreements', '--accept-source-agreements']]]);
  });
  it('uses Homebrew on macOS', () => {
    expect(installPlan('darwin', tools({ brew: true })).commands).toEqual([['brew', ['install', '--cask', 'docker']]]);
  });
  it("uses Docker's convenience script on Linux", () => {
    const plan = installPlan('linux', tools({ curl: true }));
    expect(plan.commands).toEqual([['sh', ['-c', 'curl -fsSL https://get.docker.com | sudo sh']]]);
    expect(plan.notes.join(' ')).toMatch(/usermod -aG docker/);
  });
  it('falls back to the download page when no installer tool exists', () => {
    for (const platform of ['win32', 'darwin', 'linux', 'aix']) {
      const plan = installPlan(platform, tools());
      expect(plan.commands).toEqual([]);
      expect(plan.url).toMatch(/^https:\/\/docs\.docker\.com\//);
    }
  });
});

describe('startPlan', () => {
  it('knows how to start Docker on each OS', () => {
    expect(startPlan('win32', { env: { ProgramFiles: 'C:\\Program Files' }, exists: () => false })).toEqual(['cmd', ['/c', 'start', '', 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe']]);
    const perUser = 'C:\\Users\\u\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe';
    expect(startPlan('win32', { env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, exists: (p) => p === perUser })).toEqual(['cmd', ['/c', 'start', '', perUser]]);
    expect(startPlan('darwin')).toEqual(['open', ['-a', 'Docker']]);
    expect(startPlan('linux')).toEqual(['sudo', ['systemctl', 'start', 'docker']]);
    expect(startPlan('aix')).toBeNull();
  });
});

describe('waitFor', () => {
  it('polls until the check passes or the deadline is reached', async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
    let calls = 0;
    expect(await waitFor(async () => (calls += 1) >= 3, { timeoutMs: 10000, intervalMs: 1000, ...clock })).toBe(true);
    expect(calls).toBe(3);
    expect(await waitFor(async () => false, { timeoutMs: 3000, intervalMs: 1000, ...clock })).toBe(false);
  });
});

/** Fake environment: `state` drives probe(); exec records commands and can flip state. */
function harness({ state, answers = [], interactive = true, platform = 'win32', onExec = () => 0 }) {
  const log = [];
  const ran = [];
  const asked = [];
  return {
    log, ran, asked,
    deps: {
      platform,
      interactive,
      env: {},
      probe: async () => ({ ...state }),
      prompt: async (q) => { asked.push(q); return answers.shift() ?? ''; },
      exec: async (cmd, args) => { ran.push([cmd, ...args]); return onExec(cmd, args, state); },
      log: (m) => log.push(m),
      wait: async (check) => check(),
    },
  };
}

describe('runSetup', () => {
  const none = () => ({ docker: false, dockerRunning: false, latexmk: false, tectonic: false, ...tools({ winget: true }) });

  it('does nothing when Docker is already running', async () => {
    const t = harness({ state: { ...none(), docker: true, dockerRunning: true } });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('ready');
    expect(t.asked).toEqual([]);
  });

  it('preflight is satisfied by a local TeX installation', async () => {
    const t = harness({ state: { ...none(), latexmk: true } });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('ready');
    expect(t.asked).toEqual([]);
  });

  it('offers to start an installed but stopped Docker, then waits for it', async () => {
    const t = harness({
      state: { ...none(), docker: true },
      answers: ['y'],
      onExec: (cmd, args, s) => { s.dockerRunning = true; return 0; },
    });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('ready');
    expect(t.asked[0]).toMatch(/start Docker/i);
    expect(t.ran[0][0]).toBe('cmd');
  });

  it('shows the exact install command before asking', async () => {
    const t = harness({ state: none(), answers: ['n'] });
    await runSetup({ mode: 'preflight', ...t.deps });
    expect(t.log.join('\n')).toContain('winget install -e --id Docker.DockerDesktop');
  });

  it('defaults to "no" for the Linux root install script, and does not wait after installing', async () => {
    const linux = { ...none(), winget: false, curl: true };
    const declined = harness({ state: linux, platform: 'linux', answers: [''] });
    expect(await runSetup({ mode: 'preflight', ...declined.deps })).toBe('skipped');
    expect(declined.asked[0]).toMatch(/\[y\/N\]/);
    const t = harness({ state: linux, platform: 'linux', answers: ['y'], onExec: (c, a, s) => { s.docker = true; return 0; } });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('pending');
    expect(t.ran.map((r) => r[0])).toEqual(['sh']);
    expect(t.asked).toHaveLength(1);
    expect(t.log.join('\n')).toMatch(/usermod -aG docker/);
    expect(t.log.join('\n')).not.toMatch(/WSL/);
  });

  it('explains docker-group permissions instead of offering to start Docker', async () => {
    const t = harness({ state: { ...none(), docker: true, dockerNoPermission: true }, platform: 'linux' });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('pending');
    expect(t.asked).toEqual([]);
    expect(t.log.join('\n')).toMatch(/usermod -aG docker/);
  });

  it('offers to install Docker, installs, starts and waits', async () => {
    const t = harness({
      state: none(),
      answers: ['', 'y'], // Enter = default "yes" for install; then confirm start
      onExec: (cmd, args, s) => {
        if (cmd === 'winget') s.docker = true;
        else s.dockerRunning = true;
        return 0;
      },
    });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('ready');
    expect(t.asked[0]).toMatch(/install Docker/i);
    expect(t.ran.map((r) => r[0])).toEqual(['winget', 'cmd']);
  });

  it('respects "no" and explains the alternatives', async () => {
    const t = harness({ state: none(), answers: ['n'] });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('skipped');
    expect(t.ran).toEqual([]);
    expect(t.log.join('\n')).toMatch(/TeX Live|MiKTeX/);
  });

  it('never prompts when not interactive (CI, pipes)', async () => {
    const t = harness({ state: none(), interactive: false });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('missing');
    expect(t.asked).toEqual([]);
    expect(t.log.join('\n')).toMatch(/npm run setup/);
  });

  it('reports a failed install with the manual download link', async () => {
    const t = harness({ state: none(), answers: ['y'], onExec: () => 1 });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('failed');
    expect(t.log.join('\n')).toMatch(/docs\.docker\.com/);
  });

  it('points to the download page when it cannot install automatically', async () => {
    const t = harness({ state: { ...none(), winget: false }, answers: ['y'] });
    expect(await runSetup({ mode: 'preflight', ...t.deps })).toBe('skipped');
    expect(t.ran).toEqual([]);
    expect(t.log.join('\n')).toMatch(/docs\.docker\.com/);
  });

  it('is skipped by LOCALLEAF_SKIP_SETUP or an explicit compiler choice', async () => {
    for (const env of [{ LOCALLEAF_SKIP_SETUP: '1' }, { LOCALLEAF_COMPILER: 'latexmk' }]) {
      const t = harness({ state: none() });
      expect(await runSetup({ mode: 'preflight', ...t.deps, env })).toBe('skipped');
      expect(t.asked).toEqual([]);
    }
  });

  it('full setup still offers Docker when only a local TeX exists (default no)', async () => {
    const t = harness({ state: { ...none(), latexmk: true }, answers: [''] });
    expect(await runSetup({ mode: 'full', ...t.deps })).toBe('ready');
    expect(t.asked[0]).toMatch(/\[y\/N\]/);
    expect(t.ran).toEqual([]);
  });
});

describe('createRedetectingBackend', () => {
  const missing = { name: 'none', description: 'No LaTeX compiler found', supportsSynctex: false, supportsEngines: false, compile: async () => { throw new Error('No LaTeX compiler found'); } };
  const docker = { name: 'docker', description: 'TeX Live in Docker', supportsSynctex: true, supportsEngines: true, ensureReady: vi.fn(async () => {}), compile: vi.fn(async () => ({ code: 0 })), synctexView: async () => [], synctexEdit: async () => null };

  it('picks up a compiler installed after start-up, without a restart', async () => {
    let found = missing;
    let t = 0;
    const b = createRedetectingBackend(missing, async () => found, { now: () => t, intervalMs: 5000 });
    expect(b.name).toBe('none');
    await expect(b.compile({})).rejects.toThrow(/No LaTeX/);
    found = docker;
    await expect(b.compile({})).rejects.toThrow(/No LaTeX/); // throttled: re-checked at most every 5 s
    t = 6000;
    expect(await b.compile({ id: 'x' })).toEqual({ code: 0 });
    expect(b.name).toBe('docker');
    expect(b.supportsSynctex).toBe(true);
    expect(docker.ensureReady).toHaveBeenCalled();
  });

  it('is refreshed by GET /api/health', async () => {
    const { default: request } = await import('supertest');
    const { createApp } = await import('../server/app.js');
    const { loadConfig } = await import('../server/config.js');
    let t = 0;
    const backend = createRedetectingBackend(missing, async () => docker, { now: () => t, intervalMs: 5000 });
    const app = createApp({ store: {}, compileService: {}, backend, config: loadConfig({}) });
    expect((await request(app).get('/api/health')).body.data.compiler).toBe('none');
    t = 6000;
    expect((await request(app).get('/api/health')).body.data).toMatchObject({ compiler: 'docker', supportsSynctex: true });
  });

  it('switches as soon as a compiler is found, without waiting for it to get ready (image pull)', async () => {
    let t = 6000;
    let releaseReady;
    const slow = { ...docker, ensureReady: () => new Promise((r) => { releaseReady = r; }) };
    const b = createRedetectingBackend(missing, async () => slow, { now: () => t, intervalMs: 5000 });
    t = 12000;
    await b.refresh(); // must not hang on ensureReady
    expect(b.name).toBe('docker');
    releaseReady();
  });

  it('refreshes on health checks too', async () => {
    let t = 0;
    const b = createRedetectingBackend(missing, async () => docker, { now: () => t, intervalMs: 5000 });
    t = 6000;
    await b.refresh();
    expect(b.description).toBe('TeX Live in Docker');
  });
});

describe('pathWithDocker', () => {
  it("appends Docker Desktop's CLI folder on Windows when it exists but is not on PATH", async () => {
    const { pathWithDocker } = await import('../server/compiler/dockerPath.js');
    const bin = 'C:\\Program Files\\Docker\\Docker\\resources\\bin';
    const env = { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
    expect(pathWithDocker({ platform: 'win32', env, exists: (p) => p === bin })).toEqual({ key: 'Path', value: `C:\\Windows;${bin}` });
    const already = { Path: `C:\\Windows;${bin.toUpperCase()}\\`, ProgramFiles: 'C:\\Program Files' };
    expect(pathWithDocker({ platform: 'win32', env: already, exists: () => true }).value).toBe(already.Path);
    expect(pathWithDocker({ platform: 'win32', env, exists: () => false }).value).toBe('C:\\Windows');
  });
  it('also finds a per-user Docker Desktop install', async () => {
    const { pathWithDocker } = await import('../server/compiler/dockerPath.js');
    const bin = 'C:\\Users\\u\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin';
    const env = { Path: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    expect(pathWithDocker({ platform: 'win32', env, exists: (p) => p === bin }).value).toBe(`C:\\Windows;${bin}`);
  });

  it('leaves Linux PATH alone', async () => {
    const { pathWithDocker } = await import('../server/compiler/dockerPath.js');
    expect(pathWithDocker({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => true })).toEqual({ key: 'PATH', value: '/usr/bin' });
  });
});
