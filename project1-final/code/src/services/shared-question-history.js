import { readHistory } from './question-history.js';
import { questionContentKey } from '../validators/question-content.js';

// An append-only archive of successful local versions. Contents of survey questions
// remain snapshots; only their history view is shared, within the same owner.
export async function archiveQuestionHistory(db, ownerId, question, history) {
  await db.collection('questionVersionSources').updateOne({ ownerId, questionId: question.id }, {
    $setOnInsert: { ownerId, questionId: question.id, origin: history.origin ?? null },
    $addToSet: { versions: { $each: history.versions }, origins: history.origin ?? null },
  }, { upsert: true });
}

export function sharedHistoryReader(db, ownerId) {
  let sources;
  async function load() {
    const [library, surveys, archive] = await Promise.all([
      db.collection('questionLibrary').find({ ownerId }).toArray(),
      db.collection('surveys').find({ ownerId }, { projection: { questions: 1, questionHistories: 1, createdAt: 1 } }).toArray(),
      db.collection('questionVersionSources').find({ ownerId }).toArray(),
    ]);
    const librarySources = library.map((r) => ({ questionId: r.question.id, libraryId: String(r._id),
      ...readHistory(r.question, r.questionHistory, r.createdAt) }));
    const all = [
      ...archive,
      ...librarySources,
      ...surveys.flatMap((s) => s.questions.map((q) => ({ questionId: q.id,
        ...readHistory(q, s.questionHistories?.find((h) => h.questionId === q.id)?.history, s.createdAt) }))),
    ];
    // Older imports predate provenance metadata. Link only an exact initial
    // snapshot match to this owner's library, never by title or another owner.
    const definitions = new Map();
    for (const source of librarySources) for (const version of source.versions) {
      const key = questionContentKey(version.question);
      if (!definitions.has(key)) definitions.set(key, { kind: 'library', sourceId: source.libraryId,
        questionId: source.questionId, versionId: version.id, version: version.number, title: version.question.title });
    }
    for (const source of all) {
      const initial = source.versions.find((v) => v.id === source.questionId);
      const match = initial && definitions.get(questionContentKey(initial.question));
      if (!source.origin && match && match.questionId !== source.questionId) source.origin = match;
    }
    return all;
  }
  return async (question, local) => {
    sources ??= load();
    const all = [...await sources, { questionId: question.id, ...local }];
    const parent = new Map();
    function root(id) {
      if (!parent.has(id)) parent.set(id, id);
      if (parent.get(id) !== id) parent.set(id, root(parent.get(id)));
      return parent.get(id);
    }
    function join(a, b) { parent.set(root(a), root(b)); }
    for (const source of all) {
      // Shared notifications intentionally have no private question ID linkage.
      for (const origin of [source.origin, ...source.origins ?? []]) {
        if (origin?.questionId) join(source.questionId, origin.questionId);
      }
      for (const v of source.versions) join(source.questionId, v.id);
    }
    const related = all.filter((s) => root(s.questionId) === root(question.id));
    const versions = new Map();
    for (const source of related) for (const version of source.versions) {
      if (!versions.has(version.id)) versions.set(version.id, structuredClone(version));
    }
    const aliases = new Map();
    for (const source of related) for (const origin of [source.origin, ...source.origins ?? []]) {
      const initial = versions.get(source.questionId);
      const base = versions.get(origin?.versionId);
      if (!initial || !base || initial.id === base.id) continue;
      if (questionContentKey(initial.question) === questionContentKey(base.question)) {
        if (canonical(base.id) !== initial.id) aliases.set(initial.id, canonical(base.id));
      } else if (!initial.parentVersionId) {
        initial.parentVersionId = base.id;
        initial.basedOnVersionId = base.id;
      }
    }
    function canonical(id) {
      const visited = new Set();
      while (aliases.has(id) && !visited.has(id)) { visited.add(id); id = aliases.get(id); }
      return id;
    }
    const remaining = [...versions.values()].filter((v) => !aliases.has(v.id)).map((v) => ({ ...v,
      parentVersionId: canonical(v.parentVersionId), basedOnVersionId: canonical(v.basedOnVersionId),
      restoredFromVersionId: canonical(v.restoredFromVersionId) }));
    remaining.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id));
    const ordered = [];
    const known = new Set();
    const ids = new Set(remaining.map((v) => v.id));
    while (remaining.length) {
      let index = remaining.findIndex((v) => !v.parentVersionId || known.has(v.parentVersionId) || !ids.has(v.parentVersionId));
      if (index < 0) index = 0; // Defensive compatibility for malformed legacy parent links.
      const [version] = remaining.splice(index, 1);
      known.add(version.id);
      ordered.push({ ...version, number: ordered.length + 1 });
    }
    const origin = local.origin ?? related.find((s) => s.questionId === question.id && s.origin)?.origin ?? null;
    const source = origin?.versionId && ordered.find((v) => v.id === canonical(origin.versionId));
    return { ...local, origin: source ? { ...origin, version: source.number } : origin,
      relatedQuestionIds: [...new Set(related.map((s) => s.questionId))],
      shared: true, headVersionId: canonical(local.headVersionId), versions: ordered };
  };
}
