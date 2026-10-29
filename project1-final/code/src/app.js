import express from 'express';
import { fileURLToPath } from 'node:url';
import { errorHandler, HttpError, sendData } from './middleware/errors.js';
import { assertAllowedFields, assertPlainObject, rejectUnsafeKeys } from './validators/basic.js';
import { registerAuth } from './routes/auth.js';
import { registerSurveyRoutes } from './routes/surveys.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerStatisticsRoutes } from './routes/statistics.js';
import { registerQuestionLibraryRoutes } from './routes/question-library.js';
import { registerNotificationRoutes } from './routes/notifications.js';

function registerDefaultRoutes(app, dependencies) {
  registerAuth(app, dependencies);
  registerSurveyRoutes(app, { db: dependencies.db });
  registerPublicRoutes(app, { db: dependencies.db });
  registerStatisticsRoutes(app, { db: dependencies.db });
  registerQuestionLibraryRoutes(app, { db: dependencies.db });
  registerNotificationRoutes(app, { db: dependencies.db });
}

function registerPages(app) {
  const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
  app.get('/', (req, res) => res.redirect('/surveys'));
  const pages = [
    ['/login', 'login.html'], ['/register', 'register.html'], ['/surveys', 'surveys.html'],
    ['/question-library', 'question-library.html'],
    ['/notifications', 'notifications.html'],
    ['/surveys/:surveyId/edit', 'editor.html'],
    ['/surveys/:surveyId/statistics', 'statistics.html'],
    ['/survey/:surveyId/complete', 'complete.html'], ['/survey/:surveyId', 'respond.html'],
  ];
  for (const [route, file] of pages) {
    app.get(route, (req, res, next) => {
      res.sendFile(file, { root: publicDirectory }, (error) => {
        if (error) next(error.status === 404
          ? new HttpError(404, 'NOT_FOUND', 'Resource not found') : error);
      });
    });
  }
  app.use(express.static(publicDirectory, { index: false }));
}

export function createApp({ db, client, config, registerRoutes } = {}) {
  if (!db || !client || !config) throw new TypeError('createApp requires db, client and config');
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.locals.client = client;
  app.locals.config = config;
  app.use(express.json({ limit: config.jsonLimit ?? '100kb', strict: true }));
  app.use((req, res, next) => {
    if (req.body !== undefined) {
      assertPlainObject(req.body);
      rejectUnsafeKeys(req.body);
    }
    next();
  });
  app.get('/api/health', async (req, res) => {
    assertAllowedFields(req.query, [], 'query');
    if (req.body !== undefined) assertAllowedFields(req.body, []);
    try {
      await db.command({ ping: 1 });
    } catch {
      throw new HttpError(503, 'DATABASE_UNAVAILABLE', 'Database is unavailable');
    }
    return sendData(res, { status: 'ok', database: 'connected' });
  });
  // An injected registrar replaces defaults, preserving isolated foundation tests.
  (registerRoutes ?? registerDefaultRoutes)(app, { db, client, config });
  registerPages(app);
  app.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'Resource not found')));
  app.use(errorHandler);
  return app;
}
