import { ensureQuestionLibraryUniqueness } from './question-library.js';

export async function ensureIndexes(db) {
  await db.collection('questionVersionSources').createIndex(
    { ownerId: 1, questionId: 1 }, { name: 'question_version_sources_owner_question', unique: true },
  );
  await db.collection('questionLibrary').createIndex(
    { ownerId: 1, createdAt: -1, _id: -1 }, { name: 'question_library_owner_created' },
  );
  await ensureQuestionLibraryUniqueness(db);
  await db.collection('notifications').createIndexes([
    { key: { recipientId: 1, status: 1 }, name: 'notifications_recipient_status' },
    { key: { recipientId: 1, createdAt: -1, _id: -1 }, name: 'notifications_recipient_created' },
    { key: { senderId: 1, recipientId: 1, contentKey: 1 }, name: 'notifications_sender_recipient_content_unique', unique: true },
  ]);
  await db.collection('users').createIndex(
    { usernameNormalized: 1 },
    { name: 'users_username_normalized_unique', unique: true },
  );
  await db.collection('surveys').createIndex(
    { ownerId: 1, createdAt: -1 },
    { name: 'surveys_owner_created' },
  );
  await db.collection('responses').createIndexes([
    { key: { surveyId: 1, submittedAt: -1 }, name: 'responses_survey_submitted' },
    { key: { surveyId: 1, respondentId: 1 }, name: 'responses_survey_respondent' },
    {
      key: { singleResponseKey: 1 },
      name: 'responses_single_response_unique',
      unique: true,
      partialFilterExpression: { singleResponseKey: { $type: 'string' } },
    },
  ]);
}
