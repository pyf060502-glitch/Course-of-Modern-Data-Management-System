import { HttpError } from '../middleware/errors.js';
import { assertAllowedFields, parseObjectId } from '../validators/basic.js';
import { validateSubmission } from './jump.js';

const publicProjection = {
  title: 1, description: 1, allowAnonymous: 1, allowMultipleResponses: 1,
  status: 1, deadline: 1,
  'questions.id': 1, 'questions.order': 1, 'questions.title': 1,
  'questions.type': 1, 'questions.required': 1, 'questions.options.id': 1,
  'questions.options.label': 1, 'questions.validation': 1,
  'jumpRules.id': 1, 'jumpRules.sourceQuestionId': 1, 'jumpRules.operator': 1,
  'jumpRules.value': 1, 'jumpRules.targetQuestionId': 1, 'jumpRules.priority': 1,
};

export function effectivePublicStatus(survey, now = new Date()) {
  return survey.status === 'published' && survey.deadline && survey.deadline <= now
    ? 'expired' : survey.status;
}

function assertAvailable(survey, now = new Date()) {
  if (!survey || survey.status === 'draft') {
    throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
  }
  const status = effectivePublicStatus(survey, now);
  if (status !== 'published') {
    throw new HttpError(410, 'SURVEY_UNAVAILABLE', 'Survey is closed or expired',
      { effectiveStatus: status });
  }
}

function assertParticipation(survey, user) {
  if (!user && (!survey.allowAnonymous || !survey.allowMultipleResponses)) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Login is required for this survey');
  }
}

export async function getPublicSurvey(db, surveyId, user) {
  const survey = await db.collection('surveys').findOne(
    { _id: parseObjectId(surveyId, 'surveyId'), status: { $ne: 'draft' } },
    { projection: publicProjection },
  );
  if (!survey) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
  const effectiveStatus = effectivePublicStatus(survey);
  const requiresLogin = !survey.allowAnonymous || !survey.allowMultipleResponses;
  const canSubmit = effectiveStatus === 'published' && (!requiresLogin || Boolean(user));
  return {
    id: survey._id, title: survey.title, description: survey.description,
    status: survey.status, effectiveStatus, deadline: survey.deadline,
    allowAnonymous: survey.allowAnonymous, allowMultipleResponses: survey.allowMultipleResponses,
    requiresLogin, canSubmit,
    submissionBlockedReason: effectiveStatus !== 'published' ? effectiveStatus
      : requiresLogin && !user ? 'login_required' : null,
    questions: survey.questions, jumpRules: survey.jumpRules,
  };
}

export async function submitResponse(db, surveyId, user, body) {
  assertAllowedFields(body, ['answers']);
  const _id = parseObjectId(surveyId, 'surveyId');
  const surveys = db.collection('surveys');
  const survey = await surveys.findOne({ _id });
  assertAvailable(survey);
  assertParticipation(survey, user);
  validateSubmission(survey, body.answers);

  // Final read is the close/deadline boundary, not a cross-collection transaction.
  const current = await surveys.findOne({ _id });
  assertAvailable(current);
  assertParticipation(current, user);
  const { answers, path } = validateSubmission(current, body.answers);
  const submittedAt = new Date();
  assertAvailable(current, submittedAt);
  const respondentId = user ? parseObjectId(String(user._id), 'respondentId') : null;
  const response = {
    surveyId: _id, respondentId, anonymous: respondentId === null,
    answers, path, submittedAt,
    ...(!current.allowMultipleResponses
      ? { singleResponseKey: `${_id}:${respondentId}` } : {}),
  };
  try {
    const { insertedId } = await db.collection('responses').insertOne(response);
    return {
      id: insertedId, submittedAt, completionUrl: `/survey/${_id}/complete`,
    };
  } catch (error) {
    if (error.code === 11000 && response.singleResponseKey !== undefined) {
      throw new HttpError(409, 'ALREADY_SUBMITTED', 'Only one response per registered user is allowed');
    }
    throw error;
  }
}
