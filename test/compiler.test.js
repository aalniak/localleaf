import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDockerBackend, jobName } from '../server/compiler/dockerBackend.js';
import { CompileService } from '../server/compiler/service.js';
import { ProjectStore } from '../server/projects/store.js';
import { detectBackend, hostUser } from '../server/compiler/detect.js';
import { loadConfig } from '../server/config.js';

const config = loadConfig({ LOCALLEAF_DATA_DIR: '/data-root', LOCALLEAF_COMPILE_TIMEOUT: '120' });
const meta = { mainFile: 'chapters/thesis.tex', engine: 'xelatex' };

describe('jobName', () => {
  it('strips folders and extension', () => {
    expect(jobName('chapters/thesis.tex')).toBe('thesis');
    expect(jobName('My Paper.tex')).toBe('My Paper');
  });
});

describe('docker backend', () => {
  const runnerFor = (inspect) => {
    const calls = [];
    const runner = vi.fn(async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (args[0] === 'inspect') return inspect;
      if (args[0] === 'exec' && args.includes('synctex')) {
        return { code: 0, stdout: 'SyncTeX result begin\nOutput:x\nInput:/work/p1/src/./a.tex\nLine:7\nColumn:2\nSyncTeX result end', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    });
    return { runner, calls };
  };

  it('creates the container when missing, then execs the compile script', async () => {
    const { runner, calls } = runnerFor({ code: 1, stdout: '', stderr: 'No such object' });
    const backend = createDockerBackend({ config, projectsDir: '/data-root/projects', runner });
    const result = await backend.compile({ id: 'p1', meta, draft: true });
    const run = calls.find((c) => c.args[0] === 'run');
    expect(run.args).toEqual(expect.arrayContaining(['-v', '/data-root/projects:/data', 'texlive/texlive:latest', 'infinity']));
    const exec = calls.find((c) => c.args[0] === 'exec');
    expect(exec.args.slice(-5)).toEqual(['p1', 'chapters/thesis.tex', 'xelatex', '1', '1']);
    expect(exec.args).toEqual(expect.arrayContaining(['timeout', '120', 'max_print_line=10000']));
    expect(exec.opts.input).toContain('latexmk');
    expect(exec.opts.input).not.toContain('\r');
    expect(result.rootPrefix).toBe('/work/p1/src');
  });

  it('reuses a running container with the same data label', async () => {
    const { runner, calls } = runnerFor({ code: 0, stdout: 'true|/data-root/projects\n', stderr: '' });
    const backend = createDockerBackend({ config, projectsDir: '/data-root/projects', runner });
    await backend.compile({ id: 'p1', meta, draft: false });
    expect(calls.map((c) => c.args[0])).toEqual(['inspect', 'exec']);
  });

  it('runs as the host user on POSIX so output files are not root-owned', async () => {
    const { runner, calls } = runnerFor({ code: 1, stdout: '', stderr: 'No such object' });
    const backend = createDockerBackend({ config, projectsDir: '/data-root/projects', runner, user: '1000:1000' });
    await backend.ensureReady();
    const run = calls.find((c) => c.args[0] === 'run');
    expect(run.args).toEqual(expect.arrayContaining(['--user', '1000:1000', '-e', 'HOME=/tmp', '--label', 'localleaf.user=1000:1000']));
    const prep = calls.find((c) => c.args[0] === 'exec');
    expect(prep.args).toEqual(['exec', '-u', '0', 'localleaf-texlive', 'mkdir', '-p', '-m', '1777', '/work']);
  });

  it('recreates a running container that was created for another user', async () => {
    const { runner, calls } = runnerFor({ code: 0, stdout: 'true|/data-root/projects|\n', stderr: '' });
    const backend = createDockerBackend({ config, projectsDir: '/data-root/projects', runner, user: '1000:1000' });
    await backend.ensureReady();
    expect(calls.map((c) => c.args[0])).toEqual(['inspect', 'rm', 'run', 'exec']);
  });

  it('recreates a container that points at another data dir', async () => {
    const { runner, calls } = runnerFor({ code: 0, stdout: 'true|/elsewhere\n', stderr: '' });
    const backend = createDockerBackend({ config, projectsDir: '/data-root/projects', runner });
    await backend.ensureReady();
    expect(calls.map((c) => c.args[0])).toEqual(['inspect', 'rm', 'run']);
  });

  it('flags timeouts (exit 137) and maps SyncTeX results', async () => {
    const { runner } = runnerFor({ code: 0, stdout: 'true|/data-root/projects', stderr: '' });
    runner.mockImplementationOnce(async () => ({ code: 0, stdout: 'true|/data-root/projects', stderr: '' }));
    const backend = createDockerBackend({ config, projectsDir: '/data-root/projects', runner });
    runner.mockImplementation(async (cmd, args) => (args.includes('synctex')
      ? { code: 0, stdout: 'SyncTeX result begin\nOutput:x\nInput:/work/p1/src/./a.tex\nLine:7\nColumn:2\nSyncTeX result end', stderr: '' }
      : { code: 137, stdout: '', stderr: '', timedOut: false }));
    expect((await backend.compile({ id: 'p1', meta, draft: false })).timedOut).toBe(true);
    expect(await backend.synctexEdit({ id: 'p1', meta, page: 1, x: 2, y: 3 })).toEqual({ file: 'a.tex', line: 7, column: 2 });
  });

  it('surfaces container start failures', async () => {
    const runner = vi.fn(async (cmd, args) => (args[0] === 'inspect'
      ? { code: 1, stdout: '', stderr: '' }
      : { code: 125, stdout: '', stderr: 'image not found' }));
    const backend = createDockerBackend({ config, projectsDir: '/p', runner });
    await expect(backend.ensureReady()).rejects.toThrow(/image not found/);
  });
});

describe('detectBackend', () => {
  it('derives the container user from the host process', () => {
    expect(hostUser({ getuid: () => 1000, getgid: () => 100 })).toBe('1000:100');
    expect(hostUser({})).toBeNull();
  });
  it('prefers docker, then latexmk, then tectonic, else a helpful placeholder', async () => {
    const auto = loadConfig({ LOCALLEAF_DATA_DIR: '/d' });
    const only = (name) => async (cmd) => cmd === name;
    expect((await detectBackend(auto, { exists: only('docker') })).name).toBe('docker');
    expect((await detectBackend(auto, { exists: only('latexmk') })).name).toBe('latexmk');
    expect((await detectBackend(auto, { exists: only('tectonic') })).name).toBe('tectonic');
    const none = await detectBackend(auto, { exists: async () => false });
    expect(none.name).toBe('none');
    await expect(none.compile()).rejects.toThrow(/No LaTeX compiler/);
  });
  it('honours an explicit choice', async () => {
    const forced = loadConfig({ LOCALLEAF_DATA_DIR: '/d', LOCALLEAF_COMPILER: 'tectonic' });
    expect((await detectBackend(forced, { exists: async () => true })).name).toBe('tectonic');
    expect(() => loadConfig({ LOCALLEAF_COMPILER: 'word' })).toThrow(/LOCALLEAF_COMPILER/);
  });
});

describe('CompileService', () => {
  let dir;
  let store;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localleaf-svc-'));
    store = new ProjectStore(dir);
    await store.init();
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('allows one compile per project at a time', async () => {
    let release;
    const backend = { name: 'slow', compile: () => new Promise((r) => { release = () => r({ code: 0, stdout: '', stderr: '', rootPrefix: '' }); }) };
    const svc = new CompileService({ store, backend });
    const { id } = await store.create({ name: 'p' });
    const first = svc.compile(id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(svc.compile(id)).rejects.toThrow(/already running/);
    expect(svc.isRunning(id)).toBe(true);
    release();
    expect((await first).status).toBe('none');
    expect(svc.isRunning(id)).toBe(false);
  });

  it('reports failure and timeout statuses', async () => {
    const { id } = await store.create({ name: 'p' });
    const backend = {
      name: 'x',
      compile: async ({ outputDir }) => {
        await fs.writeFile(path.join(outputDir, 'main.log'), '! Emergency stop.\n');
        return { code: 1, stdout: 'out', stderr: 'err', timedOut: false, rootPrefix: '' };
      },
    };
    const svc = new CompileService({ store, backend });
    const failed = await svc.compile(id);
    expect(failed).toMatchObject({ status: 'failure', pdf: null, output: 'out\nerr' });
    backend.compile = async () => ({ code: 137, stdout: '', stderr: '', timedOut: true, rootPrefix: '' });
    expect((await svc.compile(id)).status).toBe('timeout');
  });
});
