import { HttpError } from '../middleware/errors.js';
import { getOwnedSurvey } from '../middleware/auth.js';
import { assertAllowedFields, invalidField } from '../validators/basic.js';
import { assertQuestionId } from '../validators/questions.js';

export function parseStatisticsPagination(query) {
  assertAllowedFields(query, ['page', 'pageSize'], 'query');
  function positive(value, fallback, field, max) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)
        || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
      invalidField(`query.${field}`, `${field} must be a positive integer at most ${max}`);
    }
    return Number(value);
  }
  const pageSize = positive(query.pageSize, 20, 'pageSize', 100);
  const page = positive(query.page, 1, 'page', Math.floor(Number.MAX_SAFE_INTEGER / pageSize));
  return { page, pageSize };
}

async function aggregateStatistics(db, surveyId, questions, questionId) {
  const choiceIds = questions.filter((question) =>
    question.type === 'single' || question.type === 'multiple').map((question) => question.id);
  const answerPipeline = [
    { $unwind: '$answers' },
    ...(questionId ? [{ $match: { 'answers.questionId': questionId } }] : []),
  ];
  const [result] = await db.collection('responses').aggregate([
    { $match: { surveyId } },
    { $facet: {
      totals: [
        { $group: { _id: '$respondentId', count: { $sum: 1 },
          anonymous: { $sum: { $cond: ['$anonymous', 1, 0] } } } },
        { $group: { _id: null, totalResponses: { $sum: '$count' },
          uniqueRegisteredRespondents: { $sum: {
            $cond: [{ $ne: ['$_id', null] }, 1, 0],
          } },
          anonymousResponses: { $sum: '$anonymous' } } },
      ],
      visited: [
        { $unwind: '$path' },
        ...(questionId ? [{ $match: { path: questionId } }] : []),
        { $group: { _id: '$path', count: { $sum: 1 } } },
      ],
      answered: [
        ...answerPipeline,
        { $group: { _id: '$answers.questionId', count: { $sum: 1 },
          numericCount: { $sum: { $cond: [{ $isNumber: '$answers.value' }, 1, 0] } },
          average: { $avg: { $cond: [{ $isNumber: '$answers.value' }, '$answers.value', null] } },
          min: { $min: { $cond: [{ $isNumber: '$answers.value' }, '$answers.value', null] } },
          max: { $max: { $cond: [{ $isNumber: '$answers.value' }, '$answers.value', null] } },
        } },
      ],
      options: [
        ...answerPipeline,
        { $match: { 'answers.questionId': { $in: choiceIds } } },
        { $project: { questionId: '$answers.questionId', value: {
          $cond: [{ $isArray: '$answers.value' },
            { $setUnion: ['$answers.value', []] }, ['$answers.value']],
        } } },
        { $unwind: '$value' },
        { $match: { value: { $type: 'string' } } },
        { $group: { _id: { questionId: '$questionId', optionId: '$value' },
          count: { $sum: 1 } } },
      ],
    } },
  ]).toArray();
  return result;
}

function questionStatistics(question, aggregate) {
  const answered = aggregate.answered.find((item) => item._id === question.id);
  const answeredCount = answered?.count ?? 0;
  const result = {
    questionId: question.id, title: question.title, type: question.type,
    visitedCount: aggregate.visited.find((item) => item._id === question.id)?.count ?? 0,
    answeredCount,
  };
  if (question.type === 'single' || question.type === 'multiple') {
    result.ratioUnit = 'fraction';
    result.ratioDenominator = 'answeredCount';
    result.options = question.options.map((option) => {
      const count = aggregate.options.find((item) =>
        item._id.questionId === question.id && item._id.optionId === option.id)?.count ?? 0;
      return { id: option.id, label: option.label, count,
        ratio: answeredCount ? count / answeredCount : 0 };
    });
  } else if (question.type === 'number') {
    result.numeric = {
      count: answered?.numericCount ?? 0, average: answered?.average ?? null,
      min: answered?.min ?? null, max: answered?.max ?? null,
    };
  }
  return result;
}

export async function getSurveyStatistics(db, surveyId, userId) {
  const survey = await getOwnedSurvey(db, surveyId, userId);
  const aggregate = await aggregateStatistics(db, survey._id, survey.questions);
  const totals = aggregate.totals[0];
  return {
    surveyId: survey._id,
    totalResponses: totals?.totalResponses ?? 0,
    uniqueRegisteredRespondents: totals?.uniqueRegisteredRespondents ?? 0,
    anonymousResponses: totals?.anonymousResponses ?? 0,
    questions: survey.questions.map((question) => questionStatistics(question, aggregate)),
  };
}

export async function getQuestionStatistics(db, surveyId, userId, questionId, pagination) {
  const survey = await getOwnedSurvey(db, surveyId, userId);
  assertQuestionId(questionId);
  const question = survey.questions.find((item) => item.id === questionId);
  if (!question) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
  const aggregate = await aggregateStatistics(db, survey._id, survey.questions, questionId);
  const result = { surveyId: survey._id, ...questionStatistics(question, aggregate) };
  if (question.type === 'text' || question.type === 'number') {
    const { page, pageSize } = pagination;
    const items = await db.collection('responses').aggregate([
      { $match: { surveyId: survey._id, 'answers.questionId': questionId } },
      { $sort: { submittedAt: -1, _id: -1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      { $unwind: '$answers' },
      { $match: { 'answers.questionId': questionId } },
      { $project: { _id: 0, responseId: '$_id', submittedAt: 1, value: '$answers.value' } },
    ]).toArray();
    result.contents = {
      items, page, pageSize, totalItems: result.answeredCount,
      totalPages: Math.ceil(result.answeredCount / pageSize),
    };
  }
  return result;
}
