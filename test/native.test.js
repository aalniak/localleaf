import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run, commandExists } from '../server/compiler/exec.js';

describe('exec.run', () => {
  it('captures stdout, stderr, exit code and stdin', async () => {
    const script = 'process.stdin.on("data", d => process.stdout.write(d.toString().toUpperCase())); process.stderr.write("warn"); process.on("exit", () => { process.exitCode = 3; })';
    const res = await run(process.execPath, ['-e', script], { input: 'hello' });
    expect(res).toEqual({ code: 3, stdout: 'HELLO', stderr: 'warn', timedOut: false });
  });

  it('kills commands that exceed the timeout', async () => {
    const res = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
  });

  it('rejects when the binary does not exist; commandExists reports false', async () => {
    await expect(run('definitely-not-a-real-binary-xyz', [])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await commandExists('definitely-not-a-real-binary-xyz')).toBe(false);
    expect(await commandExists(process.execPath, ['--version'])).toBe(true);
  });
});

describe('native backends', () => {
  const runMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    runMock.mockReset();
    vi.doMock('../server/compiler/exec.js', () => ({ run: runMock, commandExists: async () => true }));
  });

  const config = { compileTimeoutSec: 60 };
  const meta = { mainFile: 'main.tex', engine: 'lualatex' };

  it('latexmk passes engine, outdir and draft option', async () => {
    const { createLatexmkBackend } = await import('../server/compiler/nativeBackends.js');
    runMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    const backend = createLatexmkBackend({ config, hasSynctex: true });
    const res = await backend.compile({ meta, draft: true, filesDir: 'C:\\p\\files', outputDir: 'C:\\p\\out' });
    const [cmd, args, opts] = runMock.mock.calls[0];
    expect(cmd).toBe('latexmk');
    expect(args).toEqual(expect.arrayContaining(['-lualatex', '-outdir=C:\\p\\out', 'main.tex']));
    expect(args.some((a) => a.startsWith('-usepretex='))).toBe(true);
    expect(opts).toMatchObject({ cwd: 'C:\\p\\files', timeoutMs: 60000 });
    expect(res.rootPrefix).toBe('C:/p/files');
  });

  it('latexmk SyncTeX uses the synctex CLI, or refuses when missing', async () => {
    const { createLatexmkBackend } = await import('../server/compiler/nativeBackends.js');
    runMock.mockResolvedValue({ stdout: 'SyncTeX result begin\nOutput:o\nPage:2\nh:1\nv:2\nW:3\nH:4\nSyncTeX result end' });
    const backend = createLatexmkBackend({ config, hasSynctex: true });
    const dirs = { filesDir: '/p/files', outputDir: '/p/out' };
    expect(await backend.synctexView({ meta, file: 'a.tex', line: 3, column: 0, ...dirs })).toEqual([{ page: 2, h: 1, v: 2, width: 3, height: 4 }]);
    runMock.mockResolvedValue({ stdout: 'SyncTeX result begin\nOutput:o\nInput:/p/files/a.tex\nLine:9\nSyncTeX result end' });
    expect(await backend.synctexEdit({ meta, page: 1, x: 1, y: 1, ...dirs })).toMatchObject({ file: 'a.tex', line: 9 });
    const noSync = createLatexmkBackend({ config, hasSynctex: false });
    await expect(noSync.synctexView({ meta, ...dirs })).rejects.toThrow(/synctex/);
    await expect(noSync.synctexEdit({ meta, ...dirs })).rejects.toThrow(/synctex/);
  });

  it('tectonic compiles with keep-logs and has no SyncTeX', async () => {
    const { createTectonicBackend } = await import('../server/compiler/nativeBackends.js');
    runMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    const backend = createTectonicBackend({ config });
    await backend.compile({ meta, filesDir: '/p/files', outputDir: '/p/out' });
    expect(runMock.mock.calls[0][1]).toEqual(expect.arrayContaining(['-X', 'compile', '--keep-logs', 'main.tex']));
    await expect(backend.synctexView()).rejects.toThrow(/Tectonic/);
    await expect(backend.ensureReady()).resolves.toBeUndefined();
  });
});
