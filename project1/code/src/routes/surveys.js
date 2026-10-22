import { requireAuth } from '../middleware/auth.js';
import { sendData } from '../middleware/errors.js';
import { assertAllowedFields } from '../validators/basic.js';
import { createSurveyService } from '../services/surveys.js';

export function registerSurveyRoutes(app, { db }) {
  const service = createSurveyService(db);
  const base = '/api/surveys';
  app.use(base, requireAuth);

  function endpoint(method, path, action, { body = false, query = false, status = 200 } = {}) {
    app[method](path, async (req, res) => {
      if (!query) assertAllowedFields(req.query, [], 'query');
      if (!body && req.body !== undefined) assertAllowedFields(req.body, []);
      return sendData(res, await action(req, req.user._id), status);
    });
  }

  endpoint('post', base, (req, userId) => service.create(userId, req.body),
    { body: true, status: 201 });
  endpoint('get', `${base}/mine`, (req, userId) => service.list(userId, req.query),
    { query: true });
  endpoint('get', `${base}/:surveyId`, (req, userId) => service.get(req.params.surveyId, userId));
  endpoint('patch', `${base}/:surveyId`,
    (req, userId) => service.patch(req.params.surveyId, userId, req.body), { body: true });
  endpoint('delete', `${base}/:surveyId`,
    (req, userId) => service.delete(req.params.surveyId, userId));
  endpoint('post', `${base}/:surveyId/publish`,
    (req, userId) => service.publish(req.params.surveyId, userId));
  endpoint('post', `${base}/:surveyId/close`,
    (req, userId) => service.close(req.params.surveyId, userId));
  endpoint('post', `${base}/:surveyId/questions`,
    (req, userId) => service.addQuestion(req.params.surveyId, userId, req.body),
    { body: true, status: 201 });
  endpoint('put', `${base}/:surveyId/questions/order`,
    (req, userId) => service.orderQuestions(req.params.surveyId, userId, req.body), { body: true });
  endpoint('patch', `${base}/:surveyId/questions/:questionId`,
    (req, userId) => service.patchQuestion(
      req.params.surveyId, userId, req.params.questionId, req.body), { body: true });
  endpoint('delete', `${base}/:surveyId/questions/:questionId`,
    (req, userId) => service.deleteQuestion(req.params.surveyId, userId, req.params.questionId));
  endpoint('put', `${base}/:surveyId/jump-rules`,
    (req, userId) => service.replaceRules(req.params.surveyId, userId, req.body), { body: true });
}
