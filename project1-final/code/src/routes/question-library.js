import { requireAuth } from '../middleware/auth.js';
import { sendData } from '../middleware/errors.js';
import { assertAllowedFields } from '../validators/basic.js';
import { createQuestionLibraryService, questionInput } from '../services/question-library.js';
import { createSurveyService } from '../services/surveys.js';
import { getLibraryStatistics } from '../services/library-statistics.js';

export function registerQuestionLibraryRoutes(app, { db }) {
  const library = createQuestionLibraryService(db);
  const surveys = createSurveyService(db);
  const base = '/api/question-library';
  app.use(base, requireAuth);
  function endpoint(method, path, action, { body = false, query = false, status = 200 } = {}) {
    app[method](path, requireAuth, async (req, res) => {
      if (!query) assertAllowedFields(req.query, [], 'query');
      if (!body && req.body !== undefined) assertAllowedFields(req.body, []);
      return sendData(res, await action(req, req.user._id), status);
    });
  }
  endpoint('get', base, (req, userId) => library.list(userId, req.query), { query: true });
  endpoint('post', base, (req, userId) => library.create(userId, req.body), { body: true, status: 201 });
  endpoint('get', `${base}/:id`, (req, userId) => library.get(req.params.id, userId));
  endpoint('get', `${base}/:id/usages`, (req, userId) => library.usages(req.params.id, userId, req.query), { query: true });
  endpoint('get', `${base}/:id/statistics`, (req, userId) => getLibraryStatistics(db, req.params.id, userId, req.query), { query: true });
  endpoint('patch', `${base}/:id`, (req, userId) => library.patch(req.params.id, userId, req.body), { body: true });
  endpoint('delete', `${base}/:id`, (req, userId) => library.delete(req.params.id, userId));
  endpoint('get', `${base}/:id/history`, (req, userId) => library.history(req.params.id, userId, req.query), { query: true });
  endpoint('post', `${base}/:id/history/restore`, (req, userId) => library.restore(req.params.id, userId, req.body), { body: true });
  endpoint('post', `${base}/:id/versions`, (req, userId) => library.branch(req.params.id, userId, req.body), { body: true, status: 201 });
  endpoint('post', `${base}/:id/share`,
    (req, userId) => library.shareFromLibrary(req.params.id, userId, req.body), { body: true });
  endpoint('post', '/api/surveys/:surveyId/questions/:questionId/share',
    (req, userId) => library.shareFromSurvey(req.params.surveyId, req.params.questionId, userId, req.body), { body: true });
  endpoint('post', '/api/surveys/:surveyId/questions/:questionId/save-to-library',
    (req, userId) => library.saveFromSurvey(req.params.surveyId, req.params.questionId, userId), { status: 201 });
  endpoint('post', '/api/surveys/:surveyId/questions/from-library', async (req, userId) => {
    assertAllowedFields(req.body, ['libraryQuestionId', 'versionId']);
    const record = req.body.versionId === undefined
      ? await library.get(req.body.libraryQuestionId, userId)
      : await library.getVersion(req.body.libraryQuestionId, userId, req.body.versionId);
    return surveys.addQuestion(req.params.surveyId, userId, { question: questionInput(record.question) }, {
      origin: { kind: 'library', sourceId: record.id, questionId: record.question.id,
        versionId: record.versionId, version: record.version, title: record.question.title },
    });
  }, { body: true, status: 201 });
}
