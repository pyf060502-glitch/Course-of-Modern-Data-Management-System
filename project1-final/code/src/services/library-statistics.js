import { createHash } from 'node:crypto';
import { HttpError } from '../middleware/errors.js';
import { assertAllowedFields, parseObjectId, invalidField } from '../validators/basic.js';
import { parseStatisticsPagination } from './statistics.js';
import { sharedHistoryReader } from './shared-question-history.js';
import { readHistory } from './question-history.js';

export async function getLibraryStatistics(db, id, userId, query) {
  assertAllowedFields(query, ['page', 'pageSize', 'group'], 'query');
  const { group: selected, ...paging } = query;
  const { page, pageSize } = parseStatisticsPagination(paging);
  const ownerId = parseObjectId(String(userId), 'userId');
  const record = await db.collection('questionLibrary').findOne({ _id: parseObjectId(id, 'libraryQuestionId'), ownerId });
  if (!record) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
  const reader = sharedHistoryReader(db, ownerId);
  const history = await reader(record.question, readHistory(record.question, record.questionHistory, record.createdAt));
  const related = new Set(history.relatedQuestionIds);
  const surveys = await db.collection('surveys').find({ ownerId, 'questions.id': { $in: [...related] } }).toArray();
  const groups = new Map();
  for (const survey of surveys) for (const q of survey.questions.filter((q) => related.has(q.id))) {
    const key = createHash('sha256').update(JSON.stringify([q.type, q.options.map((o) => o.label)])).digest('hex');
    if (!groups.has(key)) groups.set(key, { id: key, type: q.type, labels: q.options.map((o) => o.label), instances: [] });
    groups.get(key).instances.push({ surveyId: survey._id, surveyTitle: survey.title, question: q });
  }
  const ordered = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (selected !== undefined && (typeof selected !== 'string' || !groups.has(selected))) invalidField('query.group', 'Unknown statistics group');
  const [totals] = await db.collection('responses').aggregate([
    { $match: { surveyId: { $in: surveys.map((s) => s._id) } } },
    { $group: { _id: '$respondentId', count: { $sum: 1 }, anonymous: { $sum: { $cond: ['$anonymous', 1, 0] } } } },
    { $group: { _id: null, totalResponses: { $sum: '$count' }, anonymousResponses: { $sum: '$anonymous' },
      uniqueRegisteredRespondents: { $sum: { $cond: [{ $ne: ['$_id', null] }, 1, 0] } } } },
  ]).toArray();
  const results = [];
  for (const g of ordered) {
    const matches = g.instances.map((i) => ({ surveyId: i.surveyId, 'answers.questionId': i.question.id }));
    const answers = [{ $match: { surveyId: { $in: g.instances.map((i) => i.surveyId) } } },
      { $unwind: '$answers' }, { $match: { $or: matches } }];
    const [counts] = await db.collection('responses').aggregate([...answers, { $group: { _id: null,
      answeredCount: { $sum: 1 }, numericCount: { $sum: { $cond: [{ $isNumber: '$answers.value' }, 1, 0] } },
      average: { $avg: { $cond: [{ $isNumber: '$answers.value' }, '$answers.value', null] } },
      min: { $min: { $cond: [{ $isNumber: '$answers.value' }, '$answers.value', null] } },
      max: { $max: { $cond: [{ $isNumber: '$answers.value' }, '$answers.value', null] } },
    } }]).toArray();
    const [visits] = await db.collection('responses').aggregate([
      { $match: { surveyId: { $in: g.instances.map((i) => i.surveyId) } } }, { $unwind: '$path' },
      { $match: { $or: g.instances.map((i) => ({ surveyId: i.surveyId, path: i.question.id })) } }, { $count: 'count' },
    ]).toArray();
    const result = { id: g.id, type: g.type, surveyCount: new Set(g.instances.map((i) => String(i.surveyId))).size,
      questionCount: g.instances.length, visitedCount: visits?.count ?? 0, answeredCount: counts?.answeredCount ?? 0 };
    if (['single', 'multiple'].includes(g.type)) {
      const [votes] = await db.collection('responses').aggregate([...answers, { $project: {
        votes: { $switch: { branches: g.instances.map((i) => ({ case: { $and: [
          { $eq: ['$surveyId', i.surveyId] }, { $eq: ['$answers.questionId', i.question.id] },
        ] }, then: i.question.options.map((o) => ({ $cond: [{ $in: [o.id,
          { $cond: [{ $isArray: '$answers.value' }, '$answers.value', ['$answers.value']] }] }, 1, 0] })) })), default: [] } },
      } }, { $group: { _id: null, ...Object.fromEntries(g.labels.map((_, n) => [`v${n}`, { $sum: { $arrayElemAt: ['$votes', n] } }])) } }]).toArray();
      result.options = g.labels.map((label, n) => ({ id: String(n), label, count: votes?.[`v${n}`] ?? 0,
        ratio: result.answeredCount ? (votes?.[`v${n}`] ?? 0) / result.answeredCount : 0 }));
      result.ratioUnit = 'fraction'; result.ratioDenominator = 'answeredCount';
    }
    if (g.type === 'number') result.numeric = { count: counts?.numericCount ?? 0,
      average: counts?.average ?? null, min: counts?.min ?? null, max: counts?.max ?? null };
    results.push(result);
    if (g.id === (selected ?? ordered[0]?.id) && ['number', 'text'].includes(g.type)) {
      const items = await db.collection('responses').aggregate([...answers,
        { $sort: { submittedAt: -1, _id: -1, 'answers.questionId': 1 } },
        { $skip: (page - 1) * pageSize }, { $limit: pageSize },
        { $project: { _id: 0, responseId: '$_id', surveyId: 1, questionId: '$answers.questionId', submittedAt: 1, value: '$answers.value' } },
      ]).toArray();
      result.contents = { items: items.map((item) => ({ ...item, surveyTitle: surveys.find((s) => s._id.equals(item.surveyId)).title })),
        page, pageSize, totalItems: result.answeredCount, totalPages: Math.ceil(result.answeredCount / pageSize) };
    }
  }
  return { title: record.question.title, surveyCount: surveys.length, questionCount: ordered.reduce((n, g) => n + g.instances.length, 0),
    totalResponses: totals?.totalResponses ?? 0, anonymousResponses: totals?.anonymousResponses ?? 0,
    uniqueRegisteredRespondents: totals?.uniqueRegisteredRespondents ?? 0,
    visitedCount: results.reduce((n, g) => n + g.visitedCount, 0), answeredCount: results.reduce((n, g) => n + g.answeredCount, 0),
    selectedGroup: selected ?? ordered[0]?.id ?? null, groups: results };
}
