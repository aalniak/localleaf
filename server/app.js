import express from 'express';
import { projectRoutes } from './routes/projects.js';
import { fileRoutes } from './routes/files.js';
import { compileRoutes } from './routes/compile.js';
import { HttpError } from './errors.js';
import { ok } from './http.js';
import { hostAllowList, requireApiHeader, passwordGate } from './security.js';

function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, data: null, error: err.message });
  }
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, data: null, error: 'Upload is too large' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, data: null, error: 'Malformed JSON body' });
  }
  console.error(`[localleaf] ${req.method} ${req.originalUrl} failed:`, err);
  return res.status(500).json({ success: false, data: null, error: 'Internal server error (see server console)' });
}

/** Build the Express app. Static/dev frontend middleware is attached by the caller. */
export function createApp({ store, compileService, backend, config, frontend }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(hostAllowList(config.allowedHosts));
  app.use(passwordGate(config.password));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  const api = express.Router();
  api.use(requireApiHeader);
  api.use(express.json({ limit: '25mb' }));
  api.get('/health', (req, res) =>
    ok(res, {
      compiler: backend.name,
      description: backend.description,
      supportsSynctex: backend.supportsSynctex,
      supportsEngines: backend.supportsEngines,
    }),
  );
  api.use('/projects', projectRoutes({ store, config }));
  api.use('/projects/:id', fileRoutes({ store, config }));
  api.use('/projects/:id', compileRoutes({ store, compileService }));
  api.use((req, res) => res.status(404).json({ success: false, data: null, error: 'Unknown API endpoint' }));

  app.use('/api', api);
  if (frontend) app.use(frontend);
  app.use(errorHandler);
  return app;
}
