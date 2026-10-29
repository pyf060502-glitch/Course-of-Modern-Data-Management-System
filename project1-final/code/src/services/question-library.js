import { HttpError } from '../middleware/errors.js';
import { getOwnedSurvey } from '../middleware/auth.js';
import { assertAllowedFields, assertString, invalidField, parseObjectId } from '../validators/basic.js';
import { normalizeQuestion, assertQuestionId } from '../validators/questions.js';
import { parsePagination, effectiveStatus } from './surveys.js';
import { questionInput, questionContentKey } from '../validators/question-content.js';
import { initialHistory, readHistory, appendVersion, historyView, restoredQuestion, historyCondition, versionOrigin } from './question-history.js';
import { archiveQuestionHistory, sharedHistoryReader } from './shared-question-history.js';

export { questionInput } from '../validators/question-content.js';

export function createQuestionLibraryService(db) {
  const collection = db.collection('questionLibrary');
  const owner = (userId) => parseObjectId(String(userId), 'userId');
  const historyFor = (record) => readHistory(record.question, record.questionHistory, record.createdAt);
  const data = async ({ contentKey, questionHistory, ...record }, reader = sharedHistoryReader(db, record.ownerId)) => {
    const history = await reader(record.question, readHistory(record.question, questionHistory, record.createdAt));
    const head = history.versions.find((v) => v.id === history.headVersionId);
    return { ...record, id: record._id.toHexString(), version: head.number, versionId: head.id, origin: history.origin };
  };
  async function owned(id, userId) {
    const record = await collection.findOne({
      _id: parseObjectId(id, 'libraryQuestionId'), ownerId: owner(userId),
    });
    if (!record) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
    return record;
  }
  async function create(userId, input, { origin = null } = {}) {
    assertAllowedFields(input, ['question']);
    const question = normalizeQuestion(input.question);
    const now = new Date();
    const identity = { ownerId: owner(userId), contentKey: questionContentKey(question) };
    try {
      const record = await collection.findOneAndUpdate(identity,
        { $setOnInsert: { ...identity, question, questionHistory: initialHistory(question, now, origin), createdAt: now, updatedAt: now } },
        { upsert: true, returnDocument: 'after' });
      await archiveQuestionHistory(db, record.ownerId, record.question, { ...historyFor(record), origin: origin ?? historyFor(record).origin });
      return data(record);
    } catch (error) {
      // The unique index arbitrates simultaneous saves of identical content.
      if (error.code === 11000) {
        const existing = await collection.findOne(identity);
        if (existing) {
          await archiveQuestionHistory(db, existing.ownerId, existing.question, { ...historyFor(existing), origin: origin ?? historyFor(existing).origin });
          return data(existing);
        }
      }
      throw error;
    }
  }
  async function change(record, question, restoredFromVersionId = null) {
    const contentKey = questionContentKey(question);
    const before = historyFor(record);
    const questionHistory = restoredFromVersionId || contentKey !== questionContentKey(record.question)
      ? appendVersion(before, question, restoredFromVersionId) : before;
    const unchanged = { _id: record._id, ownerId: record.ownerId, question: record.question,
      questionHistory: historyCondition(record.questionHistory) };
    try {
      const updated = await collection.findOneAndUpdate(unchanged,
        { $set: { question, contentKey, questionHistory, updatedAt: new Date() } }, { returnDocument: 'after' });
      if (!updated) {
        await owned(String(record._id), record.ownerId);
        throw new HttpError(409, 'QUESTION_LIBRARY_CONFLICT', 'Question changed; reload before saving');
      }
      await archiveQuestionHistory(db, updated.ownerId, updated.question, historyFor(updated));
      return data(updated);
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existing = await collection.findOne({ ownerId: record.ownerId, contentKey });
      if (!existing) throw error;
      const targetHistory = historyFor(existing);
      const known = new Set(targetHistory.versions.map((v) => v.id));
      const offset = Math.max(...targetHistory.versions.map((v) => v.number));
      const imported = before.versions.filter((v) => !known.has(v.id)).map((v, index) => ({
        ...v, number: offset + index + 1, importedFrom: { id: String(record._id), title: record.question.title },
      }));
      const merged = appendVersion({ ...targetHistory, headVersionId: before.headVersionId,
        versions: [...targetHistory.versions, ...imported] }, existing.question, restoredFromVersionId);
      const updated = await collection.findOneAndUpdate({ _id: existing._id, ownerId: existing.ownerId,
        question: existing.question, questionHistory: historyCondition(existing.questionHistory) },
      { $set: { questionHistory: merged, updatedAt: new Date() } }, { returnDocument: 'after' });
      if (!updated) throw new HttpError(409, 'QUESTION_LIBRARY_CONFLICT', 'Question changed; reload before saving');
      await archiveQuestionHistory(db, record.ownerId, record.question, before);
      const removed = await collection.deleteOne(unchanged);
      if (!removed.deletedCount) {
        await collection.updateOne({ _id: existing._id, questionHistory: merged }, {
          $set: { updatedAt: existing.updatedAt, ...(existing.questionHistory ? { questionHistory: existing.questionHistory } : {}) },
          ...(!existing.questionHistory ? { $unset: { questionHistory: '' } } : {}),
        });
        throw new HttpError(409, 'QUESTION_LIBRARY_CONFLICT', 'Question changed; reload before saving');
      }
      await archiveQuestionHistory(db, updated.ownerId, updated.question, historyFor(updated));
      return data(updated);
    }
  }
  function surveyQuestion(survey, questionId) {
    assertQuestionId(questionId);
    const question = survey.questions.find((item) => item.id === questionId);
    if (!question) throw new HttpError(404, 'NOT_FOUND', 'Question not found');
    return question;
  }
  async function share(userId, question, input, sourceVersion = null) {
    assertAllowedFields(input, ['username']);
    const username = assertString(input.username, 'username', { min: 3, max: 32 });
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) invalidField('username', 'Invalid recipient username');
    const recipient = await db.collection('users').findOne(
      { usernameNormalized: username.toLowerCase() }, { projection: { username: 1 } },
    );
    if (!recipient) throw new HttpError(404, 'RECIPIENT_NOT_FOUND', 'Recipient user not found');
    if (recipient._id.equals(owner(userId))) {
      throw new HttpError(400, 'INVALID_RECIPIENT', 'Choose another registered user');
    }
    const sender = await db.collection('users').findOne({ _id: owner(userId) }, { projection: { username: 1 } });
    if (!sender) throw new HttpError(401, 'AUTH_REQUIRED', 'Login is required');
    const snapshot = normalizeQuestion(questionInput(question));
    const identity = { senderId: sender._id, recipientId: recipient._id, contentKey: questionContentKey(snapshot) };
    const notifications = db.collection('notifications');
    try {
      await notifications.updateOne(identity, { $setOnInsert: {
        ...identity, senderUsername: sender.username, question: snapshot,
        origin: { kind: 'shared', title: question.title, senderUsername: sender.username, version: sourceVersion ?? 1 },
        status: 'pending', createdAt: new Date(),
      } }, { upsert: true });
    } catch (error) {
      if (error.code !== 11000 || !await notifications.findOne(identity)) throw error;
    }
    return { shared: true, recipient: { username: recipient.username } };
  }
  return {
    create,
    async get(id, userId) { return data(await owned(id, userId)); },
    async usages(id, userId, query) {
      const pagination = parsePagination(query);
      const record = await owned(id, userId);
      const reader = sharedHistoryReader(db, record.ownerId);
      const history = await reader(record.question, historyFor(record));
      const related = new Set(history.relatedQuestionIds);
      const surveys = await db.collection('surveys').find({ ownerId: record.ownerId,
        'questions.id': { $in: [...related] } }).sort({ createdAt: -1, _id: -1 }).toArray();
      const { page, pageSize } = pagination;
      const items = await Promise.all(surveys.slice((page - 1) * pageSize, page * pageSize).map(async (survey) => ({
        id: String(survey._id), title: survey.title, effectiveStatus: effectiveStatus(survey),
        questions: await Promise.all(survey.questions.filter((q) => related.has(q.id)).map(async (q) => {
          const local = readHistory(q, survey.questionHistories?.find((h) => h.questionId === q.id)?.history, survey.createdAt);
          const shared = await reader(q, local);
          const version = shared.versions.find((v) => v.id === shared.headVersionId);
          return { id: q.id, order: q.order, title: q.title, versionId: version.id, version: version.number };
        })),
      })));
      return { items, total: surveys.length, page, pageSize, totalPages: Math.ceil(surveys.length / pageSize) };
    },
    async getVersion(id, userId, versionId) {
      const record = await owned(id, userId);
      const history = await sharedHistoryReader(db, record.ownerId)(record.question, historyFor(record));
      const question = restoredQuestion(history, versionId, record.question);
      const version = history.versions.find((v) => v.id === versionId);
      return { ...await data(record), question, version: version.number, versionId };
    },
    async branch(id, userId, input) {
      assertAllowedFields(input, ['versionId', 'question']);
      const source = await this.getVersion(id, userId, input.versionId);
      const question = normalizeQuestion(input.question, { existing: source.question });
      return create(userId, { question: questionInput(question) }, { origin: {
        kind: 'library', sourceId: source.id, questionId: source.question.id,
        versionId: source.versionId, version: source.version, title: source.question.title,
      } });
    },
    async list(userId, query) {
      const { page, pageSize } = parsePagination(query);
      const filter = { ownerId: owner(userId) };
      const total = await collection.countDocuments(filter);
      const items = await collection.find(filter).sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize).limit(pageSize).toArray();
      const reader = sharedHistoryReader(db, owner(userId));
      return { items: await Promise.all(items.map((record) => data(record, reader))), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
    },
    async patch(id, userId, input) {
      assertAllowedFields(input, ['question']);
      const record = await owned(id, userId);
      const question = normalizeQuestion(input.question, { existing: record.question });
      return change(record, question);
    },
    async history(id, userId, query) {
      const record = await owned(id, userId);
      return historyView(await sharedHistoryReader(db, record.ownerId)(record.question, historyFor(record)), parsePagination(query), true);
    },
    async restore(id, userId, input) {
      assertAllowedFields(input, ['versionId']);
      const record = await owned(id, userId);
      const history = await sharedHistoryReader(db, record.ownerId)(record.question, historyFor(record));
      return change(record, restoredQuestion(history, input.versionId, record.question), input.versionId);
    },
    async delete(id, userId) {
      const record = await owned(id, userId);
      await archiveQuestionHistory(db, record.ownerId, record.question, historyFor(record));
      const result = await collection.deleteOne({
        _id: parseObjectId(id, 'libraryQuestionId'), ownerId: owner(userId),
      });
      if (!result.deletedCount) throw new HttpError(404, 'NOT_FOUND', 'Resource not found');
      return { deleted: true };
    },
    async saveFromSurvey(surveyId, questionId, userId) {
      const survey = await getOwnedSurvey(db, surveyId, userId);
      const question = surveyQuestion(survey, questionId);
      const local = readHistory(question, survey.questionHistories?.find((item) => item.questionId === questionId)?.history, survey.createdAt);
      const history = await sharedHistoryReader(db, survey.ownerId)(question, local);
      return create(userId, { question: questionInput(question) }, { origin: versionOrigin('survey', survey._id, question, history, { surveyTitle: survey.title }) });
    },
    async shareFromLibrary(id, userId, input) {
      const record = await owned(id, userId);
      return share(userId, record.question, input, (await data(record)).version);
    },
    async shareFromSurvey(surveyId, questionId, userId, input) {
      const survey = await getOwnedSurvey(db, surveyId, userId);
      const question = surveyQuestion(survey, questionId);
      const local = readHistory(question, survey.questionHistories?.find((item) => item.questionId === questionId)?.history, survey.createdAt);
      const history = await sharedHistoryReader(db, survey.ownerId)(question, local);
      const head = history.versions.find((v) => v.id === history.headVersionId);
      return share(userId, question, input, head.number);
    },
  };
}
