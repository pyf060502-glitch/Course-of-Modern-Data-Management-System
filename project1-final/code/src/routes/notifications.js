import { requireAuth } from '../middleware/auth.js';
import { sendData } from '../middleware/errors.js';
import { assertAllowedFields } from '../validators/basic.js';
import { createNotificationService } from '../services/notifications.js';

export function registerNotificationRoutes(app, { db }) {
  const service = createNotificationService(db);
  app.use('/api/notifications', requireAuth);
  app.get('/api/notifications/count', async (req, res) => {
    assertAllowedFields(req.query, [], 'query');
    if (req.body !== undefined) assertAllowedFields(req.body, []);
    return sendData(res, await service.count(req.user._id));
  });
  app.get('/api/notifications', async (req, res) => {
    if (req.body !== undefined) assertAllowedFields(req.body, []);
    return sendData(res, await service.list(req.user._id, req.query));
  });
  for (const [method, path, action] of [
    ['post', '/api/notifications/:id/accept', 'accept'], ['delete', '/api/notifications/:id', 'delete'],
  ]) {
    app[method](path, async (req, res) => {
      assertAllowedFields(req.query, [], 'query');
      if (req.body !== undefined) assertAllowedFields(req.body, []);
      return sendData(res, await service[action](req.params.id, req.user._id));
    });
  }
}
