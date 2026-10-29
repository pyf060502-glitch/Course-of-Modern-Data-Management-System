import { normalizeQuestion } from '../validators/questions.js';
import { questionInput, questionContentKey } from '../validators/question-content.js';

// Runs before accepting HTTP requests. Retain the earliest ObjectId and its IDs/times.
// No survey or response references template IDs, so their snapshots need no migration.
export async function ensureQuestionLibraryUniqueness(db) {
  const collection = db.collection('questionLibrary');
  const indexName = 'question_library_owner_content_unique';
  const indexes = await collection.indexes();
  if (indexes.some((index) => index.name === indexName && index.unique
      && JSON.stringify(index.key) === JSON.stringify({ ownerId: 1, contentKey: 1 }))) return;
  const seen = new Set();
  for await (const record of collection.find({}).sort({ _id: 1 })) {
    const contentKey = questionContentKey(normalizeQuestion(questionInput(record.question)));
    const identity = `${record.ownerId.toHexString()}:${contentKey}`;
    const unchanged = { _id: record._id, ownerId: record.ownerId, question: record.question };
    if (seen.has(identity)) {
      await collection.deleteOne(unchanged);
    } else {
      if (record.contentKey !== contentKey) {
        const result = await collection.updateOne(unchanged, { $set: { contentKey } });
        if (!result.matchedCount) throw new Error('Question library changed during migration; restart to retry');
      }
      seen.add(identity);
    }
  }
  await collection.createIndex({ ownerId: 1, contentKey: 1 }, {
    name: indexName, unique: true,
  });
}
