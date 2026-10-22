import { requireAuth } from '../middleware/auth.js';
import { sendData } from '../middleware/errors.js';
import { assertAllowedFields } from '../validators/basic.js';
import {
  getSurveyStatistics, getQuestionStatistics, parseStatisticsPagination,
} from '../services/statistics.js';

export function registerStatisticsRoutes(app, { db }) {
  app.get('/api/surveys/:surveyId/statistics', requireAuth, async (req, res) => {
    assertAllowedFields(req.query, [], 'query');
    if (req.body !== undefined) assertAllowedFields(req.body, []);
    return sendData(res, await getSurveyStatistics(db, req.params.surveyId, req.user._id));
  });
  app.get('/api/surveys/:surveyId/statistics/questions/:questionId',
    requireAuth, async (req, res) => {
      const pagination = parseStatisticsPagination(req.query);
      if (req.body !== undefined) assertAllowedFields(req.body, []);
      return sendData(res, await getQuestionStatistics(
        db, req.params.surveyId, req.user._id, req.params.questionId, pagination,
      ));
    });
}
