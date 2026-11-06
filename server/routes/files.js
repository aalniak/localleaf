import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { ok } from '../http.js';
import { badRequest } from '../errors.js';
import { normalizeRelPath } from '../paths.js';

const INLINE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt']);

function requireString(value, field) {
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string`);
  return value;
}

/** File-level operations inside a project. Paths travel in the query string or JSON body. */
export function fileRoutes({ store, config }) {
  const router = express.Router({ mergeParams: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 50 } });

  router.get('/file', async (req, res) => ok(res, await store.readFile(req.params.id, req.query.path)));

  router.get('/raw', async (req, res) => {
    const full = await store.rawPath(req.params.id, req.query.path);
    const ext = path.extname(full).toLowerCase();
    // Only well-known passive types render inline; everything else downloads (no HTML/SVG execution).
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.sendFile(full, { dotfiles: 'allow', headers: INLINE_TYPES.has(ext) ? {} : { 'Content-Disposition': 'attachment' } });
  });

  router.put('/file', async (req, res) => {
    const { path: rel, content } = req.body ?? {};
    const saved = await store.writeFile(req.params.id, requireString(rel, 'path'), Buffer.from(requireString(content, 'content'), 'utf8'));
    ok(res, { path: saved, savedAt: new Date().toISOString() });
  });

  router.post('/folder', async (req, res) => {
    ok(res, { path: await store.createFolder(req.params.id, requireString(req.body?.path, 'path')) }, 201);
  });

  router.post('/upload', upload.array('files'), async (req, res) => {
    if (!req.files?.length) throw badRequest('No files uploaded');
    const dir = typeof req.body?.dir === 'string' && req.body.dir.trim() ? normalizeRelPath(req.body.dir) : '';
    const saved = [];
    for (const file of req.files) {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8'); // multer decodes names as latin1
      saved.push(await store.writeFile(req.params.id, dir ? `${dir}/${name}` : name, file.buffer));
    }
    ok(res, { paths: saved }, 201);
  });

  router.post('/move', async (req, res) => {
    const { from, to } = req.body ?? {};
    ok(res, { path: await store.move(req.params.id, requireString(from, 'from'), requireString(to, 'to')) });
  });

  router.delete('/file', async (req, res) => {
    await store.deleteEntry(req.params.id, req.query.path);
    ok(res, { deleted: normalizeRelPath(req.query.path) });
  });

  return router;
}
