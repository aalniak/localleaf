import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createApp } from '../server/app.js';
import { ProjectStore } from '../server/projects/store.js';
import { CompileService } from '../server/compiler/service.js';
import { loadConfig } from '../server/config.js';

/** Backend double that "compiles" by writing a PDF and a log with one error. */
function fakeBackend() {
  const calls = [];
  return {
    calls,
    name: 'fake',
    description: 'fake backend',
    supportsSynctex: true,
    supportsEngines: true,
    ensureReady: async () => {},
    async compile({ id, meta, draft, outputDir }) {
      calls.push({ id, mainFile: meta.mainFile, draft });
      await fs.writeFile(path.join(outputDir, 'main.pdf'), '%PDF-1.5 fake');
      await fs.writeFile(path.join(outputDir, 'main.log'), '(./main.tex\n./main.tex:3: Undefined control sequence.\nl.3 \\oops\n)');
      return { code: 0, stdout: 'ok', stderr: '', timedOut: false, rootPrefix: '/x' };
    },
    synctexView: async ({ file, line }) => [{ page: 1, h: 10, v: 20 + line, width: 5, height: 5, file }],
    synctexEdit: async ({ page }) => ({ file: 'main.tex', line: page, column: 0 }),
  };
}

let dir;
let app;
let backend;
const H = { 'X-Localleaf': '1' };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localleaf-app-'));
  const config = loadConfig({ LOCALLEAF_DATA_DIR: dir });
  const store = new ProjectStore(config.dataDir);
  await store.init();
  backend = fakeBackend();
  app = createApp({ store, backend, config, compileService: new CompileService({ store, backend }) });
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const createProject = async () => (await request(app).post('/api/projects').set(H).send({ name: 'Test' })).body.data;

describe('security guards', () => {
  it('rejects state-changing requests without the API header', async () => {
    const res = await request(app).post('/api/projects').send({ name: 'x' });
    expect(res.status).toBe(403);
  });
  it('rejects non-loopback Host headers', async () => {
    const res = await request(app).get('/api/health').set('Host', 'evil.example');
    expect(res.status).toBe(403);
  });
  it('returns 404 envelopes for unknown endpoints and projects', async () => {
    expect((await request(app).get('/api/nope')).status).toBe(404);
    const res = await request(app).get('/api/projects/0123456789abcdef');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, data: null, error: 'Project not found' });
  });
  it('reports malformed JSON as 400', async () => {
    const res = await request(app).post('/api/projects').set(H).set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });
});

describe('projects API', () => {
  it('reports health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.data).toMatchObject({ compiler: 'fake', supportsSynctex: true });
  });

  it('creates, lists, renames, downloads and deletes projects', async () => {
    const p = await createProject();
    expect((await request(app).get('/api/projects')).body.data).toHaveLength(1);
    const patched = await request(app).patch(`/api/projects/${p.id}`).set(H).send({ name: 'New name', engine: 'lualatex' });
    expect(patched.body.data).toMatchObject({ name: 'New name', engine: 'lualatex' });
    const zip = await request(app).get(`/api/projects/${p.id}/download`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(zip.headers['content-disposition']).toContain('New_name.zip');
    expect(new AdmZip(zip.body).getEntries().map((e) => e.entryName)).toEqual(['main.tex']);
    expect((await request(app).delete(`/api/projects/${p.id}`).set(H)).status).toBe(200);
  });

  it('imports a zip upload', async () => {
    const zip = new AdmZip();
    zip.addFile('proj/main.tex', Buffer.from('\\input{body}'));
    zip.addFile('proj/body.tex', Buffer.from('\\documentclass{article}'));
    const res = await request(app).post('/api/projects/import').set(H).attach('file', zip.toBuffer(), 'My_Paper.zip');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'My Paper', mainFile: 'main.tex' });
  });

  it('rejects an import without a file', async () => {
    expect((await request(app).post('/api/projects/import').set(H)).status).toBe(400);
  });
});

describe('files API', () => {
  it('reads, writes, uploads, moves and deletes files', async () => {
    const { id } = await createProject();
    const base = `/api/projects/${id}`;
    expect((await request(app).put(`${base}/file`).set(H).send({ path: 'sec/a.tex', content: 'Hello ü' })).status).toBe(200);
    expect((await request(app).get(`${base}/file?path=sec/a.tex`)).body.data).toMatchObject({ editable: true, content: 'Hello ü' });
    expect((await request(app).post(`${base}/folder`).set(H).send({ path: 'figs' })).status).toBe(201);
    const up = await request(app).post(`${base}/upload`).set(H).field('dir', 'figs').attach('files', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), 'a.png');
    expect(up.body.data.paths).toEqual(['figs/a.png']);
    const raw = await request(app).get(`${base}/raw?path=figs/a.png`);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-security-policy']).toContain('sandbox');
    expect((await request(app).post(`${base}/move`).set(H).send({ from: 'sec/a.tex', to: 'b.tex' })).body.data.path).toBe('b.tex');
    expect((await request(app).delete(`${base}/file?path=b.tex`).set(H)).status).toBe(200);
    const tree = (await request(app).get(base)).body.data.tree.map((e) => e.path);
    expect(tree).toEqual(['figs', 'figs/a.png', 'main.tex', 'sec']);
  });

  it('validates bodies and paths', async () => {
    const { id } = await createProject();
    const base = `/api/projects/${id}`;
    expect((await request(app).put(`${base}/file`).set(H).send({ path: 'a.tex' })).status).toBe(400);
    expect((await request(app).put(`${base}/file`).set(H).send({ path: '../x.tex', content: '' })).status).toBe(400);
    expect((await request(app).get(`${base}/file?path=nope.tex`)).status).toBe(404);
    expect((await request(app).post(`${base}/move`).set(H).send({ from: 'main.tex' })).status).toBe(400);
    expect((await request(app).post(`${base}/upload`).set(H)).status).toBe(400);
  });
});

describe('compile API', () => {
  it('compiles, parses the log and serves the PDF', async () => {
    const { id } = await createProject();
    const base = `/api/projects/${id}`;
    expect((await request(app).get(`${base}/output/pdf`)).status).toBe(404);
    const res = await request(app).post(`${base}/compile`).set(H).send({ draft: true });
    expect(res.body.data).toMatchObject({ status: 'error', draft: true });
    expect(res.body.data.errors[0]).toMatchObject({ file: 'main.tex', line: 3 });
    expect(backend.calls).toEqual([{ id, mainFile: 'main.tex', draft: true }]);
    const pdf = await request(app).get(`${base}/output/pdf`);
    expect(pdf.status).toBe(200);
    expect((await request(app).get(`${base}/compile/last`)).body.data).toMatchObject({ status: 'error', running: false });
    expect((await request(app).post(`${base}/clear-cache`).set(H)).status).toBe(200);
    expect((await request(app).get(`${base}/output/pdf`)).status).toBe(404);
  });

  it('refuses to compile without a main document', async () => {
    const { id } = await createProject();
    await request(app).delete(`/api/projects/${id}/file?path=main.tex`).set(H);
    const res = await request(app).post(`/api/projects/${id}/compile`).set(H).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/main document/);
  });

  it('proxies validated SyncTeX lookups', async () => {
    const { id } = await createProject();
    const base = `/api/projects/${id}`;
    expect((await request(app).get(`${base}/synctex/view?file=main.tex&line=4`)).body.data[0]).toMatchObject({ page: 1, v: 24 });
    expect((await request(app).get(`${base}/synctex/edit?page=2&x=1&y=2`)).body.data).toMatchObject({ file: 'main.tex', line: 2 });
    expect((await request(app).get(`${base}/synctex/view?file=main.tex&line=0`)).status).toBe(400);
    expect((await request(app).get(`${base}/synctex/edit?page=1&x=abc&y=2`)).status).toBe(400);
    expect((await request(app).get(`${base}/synctex/view?file=../x&line=1`)).status).toBe(400);
  });
});
