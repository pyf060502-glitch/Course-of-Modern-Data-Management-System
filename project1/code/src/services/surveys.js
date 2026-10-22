import { getOwnedSurvey } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';
import {
  LIMITS, assertAllowedFields, assertBoolean, assertString, invalidField, parseObjectId,
} from '../validators/basic.js';
import { assertQuestionId, normalizeQuestion, validateQuestions } from '../validators/questions.js';
import { validateRules } from './jump.js';

const SETTINGS = ['title', 'description', 'allowAnonymous', 'allowMultipleResponses', 'deadline'];
const METADATA = ['title', 'description', 'deadline'];

export function effectiveStatus(survey, now = new Date()) {
  return survey.status === 'published' && survey.deadline !== null
    && survey.deadline <= now ? 'expired' : survey.status;
}

export function surveyData(survey) {
  return { ...survey, id: survey._id.toHexString(), effectiveStatus: effectiveStatus(survey),
    publicUrl: `/survey/${survey._id.toHexString()}` };
}

function deadline(value) {
  if (value === null) return null;
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    invalidField('deadline', 'Deadline must be an ISO datetime with timezone or null');
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) invalidField('deadline', 'Invalid deadline');
  // Reject dates that JavaScript silently rolls into the following month.
  const day = Number(value.slice(8, 10));
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12 || day < 1
      || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    invalidField('deadline', 'Invalid calendar date');
  }
  return result;
}

function settings(input, allowed = SETTINGS) {
  assertAllowedFields(input, allowed);
  const result = {};
  if (Object.hasOwn(input, 'title')) {
    result.title = assertString(input.title, 'title', { min: 1, max: LIMITS.title });
  }
  if (Object.hasOwn(input, 'description')) {
    result.description = assertString(input.description, 'description', { max: LIMITS.description });
  }
  for (const key of ['allowAnonymous', 'allowMultipleResponses']) {
    if (Object.hasOwn(input, key)) result[key] = assertBoolean(input[key], key);
  }
  if (Object.hasOwn(input, 'deadline')) result.deadline = deadline(input.deadline);
  return result;
}

function conflict(message = 'Survey state does not allow this operation') {
  throw new HttpError(409, 'SURVEY_STATE_CONFLICT', message);
}

function assertDraft(survey) {
  if (survey.status !== 'draft') conflict('Published survey structure is locked');
}

function assertFuture(value, now) {
  if (value !== null && value <= now) invalidField('deadline', 'Deadline must be in the future');
}

function questionIndex(survey, questionId) {
  assertQuestionId(questionId);
  const index = survey.questions.findIndex((question) => question.id === questionId);
  if (index < 0) throw new HttpError(404, 'NOT_FOUND', 'Question not found');
  return index;
}

export function parsePagination(query) {
  assertAllowedFields(query, ['page', 'pageSize'], 'query');
  function parse(key, fallback, max) {
    const value = query[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)
        || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
      invalidField(`query.${key}`, `${key} must be a positive integer no greater than ${max}`);
    }
    return Number(value);
  }
  const pageSize = parse('pageSize', 20, 100);
  const page = parse('page', 1, Math.floor(Number.MAX_SAFE_INTEGER / pageSize));
  return { page, pageSize };
}

export function createSurveyService(db) {
  const surveys = db.collection('surveys');
  const owned = (surveyId, userId) => getOwnedSurvey(db, surveyId, userId);
  const filter = (survey) => ({ _id: survey._id, ownerId: survey.ownerId });

  async function update(survey, fields, stateFilter = { status: 'draft' }) {
    const updated = await surveys.findOneAndUpdate(
      { ...filter(survey), ...stateFilter },
      { $set: { ...fields, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      await owned(survey._id, survey.ownerId);
      conflict('Survey state changed; reload before editing');
    }
    return updated;
  }

  async function saveStructure(survey, questions, jumpRules) {
    validateQuestions(questions);
    const normalized = validateRules(questions, jumpRules);
    return update(survey, { questions, jumpRules: normalized });
  }

  return {
    async create(userId, input) {
      const fields = settings(input);
      if (!Object.hasOwn(fields, 'title')) invalidField('title', 'Title is required');
      const now = new Date();
      const survey = {
        ownerId: parseObjectId(String(userId), 'userId'),
        title: fields.title, description: fields.description ?? '',
        allowAnonymous: fields.allowAnonymous ?? false,
        allowMultipleResponses: fields.allowMultipleResponses ?? true,
        deadline: fields.deadline ?? null, status: 'draft',
        questions: [], jumpRules: [], createdAt: now, updatedAt: now,
        publishedAt: null, closedAt: null,
      };
      await surveys.insertOne(survey);
      return surveyData(survey);
    },

    async list(userId, query) {
      const { page, pageSize } = parsePagination(query);
      const ownerId = parseObjectId(String(userId), 'userId');
      const total = await surveys.countDocuments({ ownerId });
      const items = await surveys.find({ ownerId }).sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize).limit(pageSize).toArray();
      return { items: items.map(surveyData), page, pageSize, total,
        totalPages: Math.ceil(total / pageSize) };
    },

    async get(surveyId, userId) {
      return surveyData(await owned(surveyId, userId));
    },

    async patch(surveyId, userId, input) {
      const survey = await owned(surveyId, userId);
      const now = new Date();
      const state = effectiveStatus(survey, now);
      if (!['draft', 'published'].includes(state)) conflict();
      assertAllowedFields(input, SETTINGS);
      if (state === 'published'
          && Object.keys(input).some((key) => !METADATA.includes(key))) {
        conflict('Published participation settings are locked');
      }
      const fields = settings(input, state === 'draft' ? SETTINGS : METADATA);
      if (!Object.keys(fields).length) invalidField('body', 'At least one update field is required');
      if (state === 'published' && Object.hasOwn(fields, 'deadline')) assertFuture(fields.deadline, now);
      const stateFilter = state === 'draft' ? { status: 'draft' }
        : { status: 'published', $or: [{ deadline: null }, { deadline: { $gt: new Date() } }] };
      return surveyData(await update(survey, fields, stateFilter));
    },

    async addQuestion(surveyId, userId, input) {
      const survey = await owned(surveyId, userId);
      assertDraft(survey);
      assertAllowedFields(input, ['question']);
      if (survey.questions.length >= LIMITS.questions) invalidField('questions', 'Question limit reached');
      const question = normalizeQuestion(input.question, { order: survey.questions.length + 1 });
      await saveStructure(survey, [...survey.questions, question], survey.jumpRules);
      return { question };
    },

    async patchQuestion(surveyId, userId, questionId, input) {
      const survey = await owned(surveyId, userId);
      assertDraft(survey);
      assertAllowedFields(input, ['question']);
      const index = questionIndex(survey, questionId);
      const previous = survey.questions[index];
      const question = normalizeQuestion(input.question, { existing: previous });
      const questions = survey.questions.map((item, i) => i === index ? question : item);
      const removedRuleIds = [];
      const rules = survey.jumpRules.filter((rule) => {
        if (rule.sourceQuestionId !== questionId) return true;
        const values = Array.isArray(rule.value) ? rule.value : [rule.value];
        const invalid = previous.type !== question.type
          || (['single', 'multiple'].includes(question.type)
            && values.some((value) => !question.options.some((option) => option.id === value)));
        if (invalid) removedRuleIds.push(rule.id);
        return !invalid;
      });
      await saveStructure(survey, questions, rules);
      return { question, removedRuleIds };
    },

    async deleteQuestion(surveyId, userId, questionId) {
      const survey = await owned(surveyId, userId);
      assertDraft(survey);
      questionIndex(survey, questionId);
      const removedRuleIds = survey.jumpRules.filter((rule) => rule.sourceQuestionId === questionId
        || rule.targetQuestionId === questionId).map((rule) => rule.id);
      const questions = survey.questions.filter((question) => question.id !== questionId)
        .map((question, index) => ({ ...question, order: index + 1 }));
      const rules = survey.jumpRules.filter((rule) => !removedRuleIds.includes(rule.id));
      await saveStructure(survey, questions, rules);
      return { deleted: true, questionId, removedRuleIds };
    },

    async orderQuestions(surveyId, userId, input) {
      const survey = await owned(surveyId, userId);
      assertDraft(survey);
      assertAllowedFields(input, ['questionIds']);
      const ids = input.questionIds;
      if (!Array.isArray(ids) || ids.length !== survey.questions.length
          || new Set(ids).size !== ids.length) {
        invalidField('questionIds', 'Provide the complete question list without duplicates');
      }
      const byId = new Map(survey.questions.map((question) => [question.id, question]));
      const questions = ids.map((id, index) => {
        assertQuestionId(id, `questionIds[${index}]`);
        if (!byId.has(id)) invalidField('questionIds', 'Unknown question ID');
        return { ...byId.get(id), order: index + 1 };
      });
      await saveStructure(survey, questions, survey.jumpRules);
      return { questions };
    },

    async replaceRules(surveyId, userId, input) {
      const survey = await owned(surveyId, userId);
      assertDraft(survey);
      assertAllowedFields(input, ['rules']);
      const rules = validateRules(survey.questions, input.rules);
      await update(survey, { jumpRules: rules });
      return { rules };
    },

    async publish(surveyId, userId) {
      const survey = await owned(surveyId, userId);
      const now = new Date();
      const state = effectiveStatus(survey, now);
      if (state === 'published') return surveyData(survey);
      if (state !== 'draft') conflict('Closed or expired surveys cannot be published');
      settings({ title: survey.title, description: survey.description,
        allowAnonymous: survey.allowAnonymous, allowMultipleResponses: survey.allowMultipleResponses });
      if (!survey.questions.length) invalidField('questions', 'Publishing requires at least one question');
      validateQuestions(survey.questions);
      validateRules(survey.questions, survey.jumpRules);
      assertFuture(survey.deadline, now);
      return surveyData(await update(survey, { status: 'published', publishedAt: now }));
    },

    async close(surveyId, userId) {
      const survey = await owned(surveyId, userId);
      if (survey.status === 'closed') return surveyData(survey);
      if (survey.status === 'draft') conflict('Draft surveys cannot be closed');
      return surveyData(await update(survey,
        { status: 'closed', closedAt: new Date() }, { status: 'published' }));
    },

    async delete(surveyId, userId) {
      let survey = await owned(surveyId, userId);
      if (survey.status !== 'closed') {
        survey = await update(survey, { status: 'closed', closedAt: new Date() },
          { status: survey.status });
      }
      // Normal cascade only; no cross-collection transaction or in-flight submission compensation.
      const responses = await db.collection('responses').deleteMany({ surveyId: survey._id });
      const result = await surveys.deleteOne({ ...filter(survey), status: 'closed' });
      if (!result.deletedCount) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
      return { deleted: true, deletedResponses: responses.deletedCount };
    },
  };
}
