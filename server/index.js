import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { loadConfig, ROOT_DIR } from './config.js';
import { ProjectStore } from './projects/store.js';
import { CompileService } from './compiler/service.js';
import { detectBackend, createRedetectingBackend } from './compiler/detect.js';
import { ensureDockerOnPath } from './compiler/dockerPath.js';
import { createApp } from './app.js';

async function frontendMiddleware(config, dev) {
  if (dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({ root: path.join(ROOT_DIR, 'web'), server: { middlewareMode: true }, appType: 'spa' });
    return vite.middlewares;
  }
  if (!fs.existsSync(path.join(config.webDist, 'index.html'))) {
    throw new Error('Frontend not built. Run "npm start" (builds automatically) or "npm run dev".');
  }
  const router = express.Router();
  router.use(express.static(config.webDist, { index: 'index.html' }));
  router.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  return router;
}

async function main() {
  const dev = process.argv.includes('--dev');
  const config = loadConfig();
  const store = new ProjectStore(config.dataDir);
  await store.init();

  ensureDockerOnPath();
  const detected = await detectBackend(config);
  const backend = config.compiler === 'auto' ? createRedetectingBackend(detected, () => detectBackend(config)) : detected;
  console.log(`[localleaf] compiler: ${backend.description}`);
  backend.ensureReady().then(
    () => console.log('[localleaf] compiler ready'),
    (err) => console.error(`[localleaf] compiler not ready yet: ${err.message}`),
  );

  const compileService = new CompileService({ store, backend });
  const frontend = await frontendMiddleware(config, dev);
  const app = createApp({ store, compileService, backend, config, frontend });
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!loopback && !config.password) {
    console.warn(`[localleaf] note: listening on ${config.host} without LOCALLEAF_PASSWORD. Fine if the port is only published to localhost (the docker-compose default); otherwise set a password.`);
  }
  app.listen(config.port, config.host, () => {
    console.log(`[localleaf] open http://localhost:${config.port}  (data: ${config.dataDir})`);
  });
}

main().catch((err) => {
  console.error(`[localleaf] failed to start: ${err.message}`);
  process.exit(1);
});
