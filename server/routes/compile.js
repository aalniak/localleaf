import express from 'express';
import { ok } from '../http.js';
import { notFound } from '../errors.js';

export function compileRoutes({ store, compileService }) {
  const router = express.Router({ mergeParams: true });

  router.post('/compile', async (req, res) => {
    ok(res, await compileService.compile(req.params.id, { draft: req.body?.draft === true }));
  });

  router.get('/compile/last', async (req, res) => {
    const last = await compileService.lastOutput(req.params.id);
    ok(res, { ...last, running: compileService.isRunning(req.params.id) });
  });

  router.post('/clear-cache', async (req, res) => {
    await store.clearOutput(req.params.id);
    ok(res, { cleared: true });
  });

  router.get('/output/pdf', async (req, res) => {
    const file = await compileService.pdfPath(req.params.id);
    if (!file) throw notFound('No PDF yet. Compile the project first');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(file);
  });

  router.get('/synctex/view', async (req, res) => {
    ok(res, await compileService.syncFromSource(req.params.id, req.query));
  });

  router.get('/synctex/edit', async (req, res) => {
    ok(res, await compileService.syncFromPdf(req.params.id, req.query));
  });

  return router;
}
