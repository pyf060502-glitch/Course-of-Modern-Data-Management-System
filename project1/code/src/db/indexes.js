export async function ensureIndexes(db) {
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
