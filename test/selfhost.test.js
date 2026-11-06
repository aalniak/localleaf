// Self-hosting features: allowed hosts, optional password, in-container TeX Live backend.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { ProjectStore } from '../server/projects/store.js';
import { CompileService } from '../server/compiler/service.js';
import { loadConfig } from '../server/config.js';
import { detectBackend } from '../server/compiler/detect.js';
import { createTexliveBackend } from '../server/compiler/texliveBackend.js';
import { run } from '../server/compiler/exec.js';

const backend = {
  name: 'fake', description: 'fake', supportsSynctex: false, supportsEngines: true,
  ensureReady: async () => {}, compile: async () => ({ code: 0, stdout: '', stderr: '' }),
};

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localleaf-self-')); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

async function appWith(env) {
  const config = loadConfig({ LOCALLEAF_DATA_DIR: dir, ...env });
  const store = new ProjectStore(config.dataDir);
  await store.init();
  return createApp({ store, backend, config, compileService: new CompileService({ store, backend }) });
}

describe('config', () => {
  it('parses allowed hosts, password, work dir and the texlive compiler mode', () => {
    const c = loadConfig({ LOCALLEAF_ALLOWED_HOSTS: ' Latex.Lan , 10.0.0.5 ,', LOCALLEAF_PASSWORD: 's3cret', LOCALLEAF_WORK_DIR: '/w', LOCALLEAF_COMPILER: 'texlive' });
    expect(c.allowedHosts).toEqual(['latex.lan', '10.0.0.5']);
    expect(c.password).toBe('s3cret');
    expect(c.workDir).toBe(path.resolve('/w'));
    expect(c.compiler).toBe('texlive');
  });
  it('defaults to loopback only and no password', () => {
    const c = loadConfig({});
    expect(c.allowedHosts).toEqual([]);
    expect(c.password).toBe('');
  });
});

describe('Host allow-list', () => {
  it('is enforced even when bound to all interfaces', async () => {
    const app = await appWith({ LOCALLEAF_HOST: '0.0.0.0' });
    expect((await request(app).get('/api/health').set('Host', 'evil.example')).status).toBe(403);
    expect((await request(app).get('/api/health').set('Host', 'localhost:4000')).status).toBe(200);
  });
  it('accepts configured hosts (with or without port)', async () => {
    const app = await appWith({ LOCALLEAF_ALLOWED_HOSTS: 'latex.lan' });
    expect((await request(app).get('/api/health').set('Host', 'LaTeX.lan:8080')).status).toBe(200);
    expect((await request(app).get('/api/health').set('Host', 'other.lan')).status).toBe(403);
  });
  it('"*" disables the check (for use behind a reverse proxy)', async () => {
    const app = await appWith({ LOCALLEAF_ALLOWED_HOSTS: '*' });
    expect((await request(app).get('/api/health').set('Host', 'anything.example')).status).toBe(200);
  });
});

describe('password protection', () => {
  const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  it('requires HTTP Basic auth on the UI and API when a password is set', async () => {
    const app = await appWith({ LOCALLEAF_PASSWORD: 's3cret' });
    const denied = await request(app).get('/api/projects');
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toMatch(/^Basic realm="Localleaf"/);
    expect((await request(app).get('/api/projects').set('Authorization', basic('any', 'wrong'))).status).toBe(401);
    expect((await request(app).get('/api/projects').set('Authorization', 'Bearer x')).status).toBe(401);
    expect((await request(app).get('/api/projects').set('Authorization', basic('anyone', 's3cret'))).status).toBe(200);
  });
  it('leaves the health check open for container probes', async () => {
    const app = await appWith({ LOCALLEAF_PASSWORD: 's3cret' });
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
  it('is off by default', async () => {
    const app = await appWith({});
    expect((await request(app).get('/api/projects')).status).toBe(200);
  });
});

describe('exec env handling', () => {
  it('removes variables whose override is undefined', async () => {
    process.env.LOCALLEAF_TEST_SECRET = 'leak';
    try {
      const code = 'process.stdout.write(String(process.env.LOCALLEAF_TEST_SECRET))';
      const { stdout } = await run(process.execPath, ['-e', code], { env: { LOCALLEAF_TEST_SECRET: undefined } });
      expect(stdout).toBe('undefined');
    } finally {
      delete process.env.LOCALLEAF_TEST_SECRET;
    }
  });
});

describe('texlive (in-container) backend', () => {
  const config = loadConfig({ LOCALLEAF_DATA_DIR: '/srv/data', LOCALLEAF_WORK_DIR: '/tmp/ll-work', LOCALLEAF_COMPILE_TIMEOUT: '60' });
  const meta = { mainFile: 'main.tex', engine: 'pdflatex' };

  it('runs the shared compile script locally with confined, scrubbed TeX settings', async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
    const b = createTexliveBackend({ config, projectsDir: '/srv/data/projects', runner });
    const result = await b.compile({ id: 'p1', meta, draft: true });
    const [cmd, args, opts] = runner.mock.calls[0];
    expect(cmd).toBe('timeout');
    expect(args).toEqual(['-s', 'KILL', '60', 'bash', '-s', '--', 'p1', 'main.tex', 'pdflatex', '1', '1']);
    expect(opts.input).toMatch(/LOCALLEAF_DATA_ROOT/);
    expect(opts.env).toMatchObject({
      LOCALLEAF_DATA_ROOT: '/srv/data/projects',
      LOCALLEAF_WORK_ROOT: path.resolve('/tmp/ll-work'),
      openout_any: 'p',
      max_print_line: '10000',
    });
    expect(opts.env).toHaveProperty('LOCALLEAF_PASSWORD', undefined);
    expect(result.rootPrefix).toBe(`${path.resolve('/tmp/ll-work').replace(/\\/g, '/')}/p1/src`);
  });

  it('reports exit 137 as a timeout', async () => {
    const runner = async () => ({ code: 137, stdout: '', stderr: '', timedOut: false });
    const b = createTexliveBackend({ config, projectsDir: '/p', runner });
    expect((await b.compile({ id: 'p1', meta, draft: false })).timedOut).toBe(true);
  });

  it('answers SyncTeX lookups against the work copy', async () => {
    const work = path.resolve('/tmp/ll-work').replace(/\\/g, '/');
    const runner = vi.fn(async (cmd, args) => (args[0] === 'view'
      ? { code: 0, stdout: 'SyncTeX result begin\nOutput:x\nPage:2\nx:1\ny:2\nh:10\nv:20\nW:30\nH:5\nSyncTeX result end', stderr: '' }
      : { code: 0, stdout: `SyncTeX result begin\nOutput:x\nInput:${work}/p1/src/./a.tex\nLine:7\nColumn:2\nSyncTeX result end`, stderr: '' }));
    const b = createTexliveBackend({ config, projectsDir: '/p', runner });
    const view = await b.synctexView({ id: 'p1', meta, file: 'a.tex', line: 7, column: 0 });
    expect(view[0]).toMatchObject({ page: 2, h: 10, v: 20 });
    expect(runner.mock.calls[0][1]).toEqual(['view', '-i', `7:0:${work}/p1/src/a.tex`, '-o', `${work}/p1/out/main.pdf`]);
    expect(await b.synctexEdit({ id: 'p1', meta, page: 1, x: 2, y: 3 })).toEqual({ file: 'a.tex', line: 7, column: 2 });
  });

  it('is selected by LOCALLEAF_COMPILER=texlive', async () => {
    const c = loadConfig({ LOCALLEAF_DATA_DIR: '/d', LOCALLEAF_COMPILER: 'texlive' });
    expect((await detectBackend(c, { exists: async () => true })).name).toBe('texlive');
  });
});

describe('review fixes', () => {
  const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  it('strips ports from allowed hosts and keeps IPv6 literals intact', () => {
    const c = loadConfig({ LOCALLEAF_ALLOWED_HOSTS: 'latex.lan:8080,[fd00::1]:4000,fd00::2,10.0.0.5:80' });
    expect(c.allowedHosts).toEqual(['latex.lan', '[fd00::1]', '[fd00::2]', '10.0.0.5']);
  });
  it('serves a host configured with a port, and an IPv6 host', async () => {
    const app = await appWith({ LOCALLEAF_ALLOWED_HOSTS: 'latex.lan:8080,fd00::2' });
    expect((await request(app).get('/api/health').set('Host', 'latex.lan:8080')).status).toBe(200);
    expect((await request(app).get('/api/health').set('Host', '[fd00::2]:4000')).status).toBe(200);
  });
  it('treats a whitespace-only password as unset', () => {
    expect(loadConfig({ LOCALLEAF_PASSWORD: '   ' }).password).toBe('');
    expect(loadConfig({ LOCALLEAF_PASSWORD: ' pw ' }).password).toBe('pw');
  });
  it('accepts a lower-case Basic scheme and rejects credentials without a colon', async () => {
    const app = await appWith({ LOCALLEAF_PASSWORD: 'pw' });
    const lower = `basic ${Buffer.from('u:pw').toString('base64')}`;
    expect((await request(app).get('/api/projects').set('Authorization', lower)).status).toBe(200);
    const noColon = `Basic ${Buffer.from('pw').toString('base64')}`;
    expect((await request(app).get('/api/projects').set('Authorization', noColon)).status).toBe(401);
  });
  it('throttles repeated wrong passwords per client', async () => {
    const app = await appWith({ LOCALLEAF_PASSWORD: 'pw' });
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).get('/api/projects').set('Authorization', basic('u', 'bad'))).status).toBe(401);
    }
    const blocked = await request(app).get('/api/projects').set('Authorization', basic('u', 'pw'));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('passwordGate throttle window', () => {
  it('lets a client try again after the window and resets on success', async () => {
    const { passwordGate } = await import('../server/security.js');
    let t = 0;
    const gate = passwordGate('pw', { maxFailures: 2, windowMs: 1000, now: () => t });
    const call = (auth) => {
      const res = { headers: {}, code: 0, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json() { return this; } };
      let passed = false;
      gate({ path: '/x', ip: '1.2.3.4', get: () => auth }, res, () => { passed = true; });
      return passed ? 200 : res.code;
    };
    const bad = `Basic ${Buffer.from('u:no').toString('base64')}`;
    const good = `Basic ${Buffer.from('u:pw').toString('base64')}`;
    expect([call(bad), call(bad), call(good)]).toEqual([401, 401, 429]);
    t = 1001;
    expect(call(good)).toBe(200);
    expect([call(bad), call(bad)]).toEqual([401, 401]);
  });
});

describe('docker backend /work preparation', () => {
  it('fails clearly when /work cannot be prepared', async () => {
    const { createDockerBackend } = await import('../server/compiler/dockerBackend.js');
    const runner = async (cmd, args) => {
      if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'No such object' };
      if (args[0] === 'exec') return { code: 1, stdout: '', stderr: 'mkdir: permission denied' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const config = loadConfig({ LOCALLEAF_DATA_DIR: '/d' });
    const b = createDockerBackend({ config, projectsDir: '/d/projects', runner, user: '1000:1000' });
    await expect(b.ensureReady()).rejects.toThrow(/prepare \/work.*permission denied/);
  });
});

describe('reverse proxy support', () => {
  it('uses X-Forwarded-For for throttling only when LOCALLEAF_TRUST_PROXY is set', async () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ LOCALLEAF_TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(loadConfig({ LOCALLEAF_TRUST_PROXY: '1' }).trustProxy).toBe(1);
    const app = await appWith({ LOCALLEAF_PASSWORD: 'pw', LOCALLEAF_TRUST_PROXY: 'true' });
    const bad = `Basic ${Buffer.from('u:x').toString('base64')}`;
    for (let i = 0; i < 10; i += 1) await request(app).get('/api/projects').set('X-Forwarded-For', '9.9.9.9').set('Authorization', bad);
    expect((await request(app).get('/api/projects').set('X-Forwarded-For', '9.9.9.9').set('Authorization', bad)).status).toBe(429);
    expect((await request(app).get('/api/projects').set('X-Forwarded-For', '8.8.8.8').set('Authorization', bad)).status).toBe(401);
  });
});
