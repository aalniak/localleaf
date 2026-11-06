import express from 'express';
import multer from 'multer';
import { ok } from '../http.js';
import { badRequest } from '../errors.js';
import { readZipEntries, buildZip } from '../projects/zipImport.js';

const nameFromZip = (filename) =>
  (filename || 'Imported project').replace(/\.zip$/i, '').replace(/[_]+/g, ' ').trim() || 'Imported project';

const safeDownloadName = (name) => `${name.replace(/[^\w.-]+/g, '_').slice(0, 100) || 'project'}.zip`;

export function projectRoutes({ store, config }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

  router.get('/', async (req, res) => ok(res, await store.list()));

  router.post('/', async (req, res) => {
    const meta = await store.create({ name: req.body?.name ?? 'Untitled project' });
    ok(res, meta, 201);
  });

  router.post('/import', upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('Attach a .zip file in the "file" field');
    const entries = readZipEntries(req.file.buffer);
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name : nameFromZip(req.file.originalname);
    ok(res, await store.create({ name, entries }), 201);
  });

  router.get('/:id', async (req, res) => {
    const [meta, tree] = await Promise.all([store.get(req.params.id), store.tree(req.params.id)]);
    ok(res, { ...meta, tree });
  });

  router.patch('/:id', async (req, res) => {
    const { name, mainFile, engine } = req.body ?? {};
    ok(res, await store.update(req.params.id, { name, mainFile, engine }));
  });

  router.delete('/:id', async (req, res) => {
    await store.remove(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  router.get('/:id/download', async (req, res) => {
    const meta = await store.get(req.params.id);
    const zip = buildZip(await store.exportEntries(req.params.id));
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${safeDownloadName(meta.name)}"`);
    res.send(zip);
  });

  return router;
}
