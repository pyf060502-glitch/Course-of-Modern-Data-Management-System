import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';
import { parseObjectId } from '../validators/basic.js';

export function createCsrfToken() {
  return randomBytes(32).toString('hex');
}

export function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = req.session?.csrfToken;
  const supplied = req.get('X-CSRF-Token');
  if (typeof expected !== 'string' || typeof supplied !== 'string'
      || !/^[a-f0-9]{64}$/.test(supplied)
      || supplied.length !== expected.length
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return next(new HttpError(403, 'CSRF_INVALID', 'A valid session CSRF token is required'));
  }
  return next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'AUTH_REQUIRED', 'Login is required'));
  return next();
}

export async function getOwnedSurvey(db, surveyId, userId) {
  if (!userId) throw new HttpError(401, 'AUTH_REQUIRED', 'Login is required');
  const survey = await db.collection('surveys').findOne({
    _id: parseObjectId(String(surveyId), 'surveyId'),
    ownerId: parseObjectId(String(userId), 'userId'),
  });
  if (!survey) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
  return survey;
}

export async function requireSurveyOwner(req, res, next) {
  try {
    if (!req.user) throw new HttpError(401, 'AUTH_REQUIRED', 'Login is required');
    req.survey = await getOwnedSurvey(req.app.locals.db, req.params.surveyId, req.user._id);
    next();
  } catch (error) {
    next(error);
  }
}
