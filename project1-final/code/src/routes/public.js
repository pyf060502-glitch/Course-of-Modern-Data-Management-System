import { sendData } from '../middleware/errors.js';
import { assertAllowedFields } from '../validators/basic.js';
import { getPublicSurvey, submitResponse } from '../services/responses.js';

export function registerPublicRoutes(app, { db }) {
  app.get('/api/public/surveys/:surveyId', async (req, res) => {
    assertAllowedFields(req.query, [], 'query');
    if (req.body !== undefined) assertAllowedFields(req.body, []);
    return sendData(res, await getPublicSurvey(db, req.params.surveyId, req.user));
  });
  app.post('/api/public/surveys/:surveyId/responses', async (req, res) => {
    assertAllowedFields(req.query, [], 'query');
    return sendData(res, await submitResponse(db, req.params.surveyId, req.user, req.body), 201);
  });
}
