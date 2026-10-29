import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errors.js';
import { assertQuestionId, validateQuestions } from '../validators/questions.js';

export function initialHistory(question, createdAt = new Date(), origin = null) {
  return { headVersionId: question.id, origin, versions: [{
    id: question.id, number: 1, parentVersionId: null, basedOnVersionId: null,
    restoredFromVersionId: null, question: structuredClone(question), createdAt,
  }] };
}

export function readHistory(question, stored, createdAt) {
  return stored ?? initialHistory(question, createdAt);
}

export function appendVersion(history, question, restoredFromVersionId = null) {
  const id = randomUUID();
  const version = { id, number: Math.max(...history.versions.map((v) => v.number)) + 1,
    parentVersionId: history.headVersionId, basedOnVersionId: restoredFromVersionId ?? history.headVersionId,
    restoredFromVersionId, question: structuredClone(question), createdAt: new Date() };
  return { ...history, headVersionId: id, versions: [...history.versions, version] };
}

export function historyView(history, { page, pageSize }, canRestore) {
  const numberOf = (id) => history.versions.find((v) => v.id === id)?.number ?? null;
  return { currentVersion: numberOf(history.headVersionId), origin: history.origin, shared: history.shared ?? false,
    canRestore, total: history.versions.length, page, pageSize,
    totalPages: Math.ceil(history.versions.length / pageSize),
    items: [...history.versions].reverse().slice((page - 1) * pageSize, page * pageSize).map((v) => ({
      ...v, parentVersion: numberOf(v.parentVersionId), basedOnVersion: numberOf(v.basedOnVersionId),
      restoredFromVersion: numberOf(v.restoredFromVersionId), current: v.id === history.headVersionId,
    })) };
}

export function restoredQuestion(history, versionId, current) {
  assertQuestionId(versionId, 'versionId');
  const version = history.versions.find((v) => v.id === versionId);
  if (!version) throw new HttpError(404, 'NOT_FOUND', 'Question version not found');
  const question = { ...structuredClone(version.question), id: current.id, order: current.order };
  validateQuestions([{ ...question, order: 1 }]);
  return question;
}

export function historyCondition(stored) {
  return stored === undefined ? { $exists: false } : stored;
}

export function versionOrigin(kind, sourceId, question, history, extra = {}) {
  const head = history.versions.find((v) => v.id === history.headVersionId);
  return { kind, sourceId: String(sourceId), questionId: question.id, versionId: head.id,
    version: head.number, title: question.title, ...extra };
}
