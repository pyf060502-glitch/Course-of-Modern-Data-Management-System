import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { ObjectId } from 'mongodb';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/db/connection.js';
import { normalizeQuestion } from '../src/validators/questions.js';
import { END, validateRules } from '../src/services/jump.js';

export const SEED_TAG = 'survey-demo-v1';
export const DEMO_USERNAME = 'survey_demo';
export const DEMO_USER_ID = '000000000000000000000010';
export const DEMO_SURVEY_ID = '000000000000000000000020';

function demoStructure() {
  const questions = [
    { title: 'Would you like to continue?', type: 'single', required: true,
      options: [{ label: 'Continue' }, { label: 'Finish now' }] },
    { title: 'Which features do you use?', type: 'multiple', required: true,
      options: [{ label: 'Forms' }, { label: 'Reports' }, { label: 'Other' }],
      validation: { minSelections: 1, maxSelections: 2 } },
    { title: 'How many surveys have you completed?', type: 'number', required: true,
      validation: { min: 0, max: 100, integer: true } },
    { title: 'Share a suggestion', type: 'text', required: true,
      validation: { minLength: 2, maxLength: 200 } },
  ].map((input, index) => normalizeQuestion(input, { order: index + 1 }));
  const [single, multiple, number, text] = questions;
  const jumpRules = validateRules(questions, [
    { sourceQuestionId: single.id, operator: 'equals', value: single.options[1].id,
      targetQuestionId: END, priority: 0 },
    { sourceQuestionId: multiple.id, operator: 'contains', value: multiple.options[1].id,
      targetQuestionId: text.id, priority: 0 },
    { sourceQuestionId: number.id, operator: 'greater_or_equal', value: 10,
      targetQuestionId: END, priority: 0 },
  ]);
  return { questions, jumpRules };
}

export async function seedDemo(config = loadConfig(), password = process.env.SEED_PASSWORD) {
  if (typeof password !== 'string' || [...password].length < 8
      || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('SEED_PASSWORD must contain at least 8 characters and at most 72 UTF-8 bytes');
  }
  const userId = new ObjectId(DEMO_USER_ID);
  const surveyId = new ObjectId(DEMO_SURVEY_ID);
  const { db, client } = await connectDatabase(config);
  try {
    const users = db.collection('users');
    const surveys = db.collection('surveys');
    const userFilter = { _id: userId, username: DEMO_USERNAME,
      usernameNormalized: DEMO_USERNAME, seedTag: SEED_TAG };
    const surveyFilter = { _id: surveyId, ownerId: userId, seedTag: SEED_TAG };
    // Preflight both identities before inserting; never adopt a same-name real user.
    const conflicts = await users.find({ $or: [
      { _id: userId }, { usernameNormalized: DEMO_USERNAME }, { username: DEMO_USERNAME },
    ] }).toArray();
    if (conflicts.some((user) => !user._id.equals(userId)
        || user.username !== DEMO_USERNAME || user.usernameNormalized !== DEMO_USERNAME
        || user.seedTag !== SEED_TAG)) {
      throw new Error('Seed identity conflict: demo user ID or username is already occupied');
    }
    const existingSurvey = await surveys.findOne({ _id: surveyId });
    if (existingSurvey && (existingSurvey.seedTag !== SEED_TAG
        || !(existingSurvey.ownerId instanceof ObjectId) || !existingSurvey.ownerId.equals(userId))) {
      throw new Error('Seed identity conflict: demo survey ID is already occupied');
    }
    const now = new Date();
    const userResult = await users.updateOne(userFilter, {
      $setOnInsert: { ...userFilter, passwordHash: await bcrypt.hash(password, 12), createdAt: now },
    }, { upsert: true });
    const surveyResult = await surveys.updateOne(surveyFilter, {
      $setOnInsert: {
        ...surveyFilter, title: 'Demo: survey features and feedback',
        description: 'Four question types; choice and numeric jumps, including END.',
        allowAnonymous: true, allowMultipleResponses: true, deadline: null,
        status: 'published', ...demoStructure(),
        createdAt: now, updatedAt: now, publishedAt: now, closedAt: null,
      },
    }, { upsert: true });
    return { username: DEMO_USERNAME, surveyId: DEMO_SURVEY_ID,
      userInserted: userResult.upsertedCount === 1,
      surveyInserted: surveyResult.upsertedCount === 1 };
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await seedDemo();
    console.log(`Seed complete: user ${result.userInserted ? 'inserted' : 'preserved'}, `
      + `survey ${result.surveyInserted ? 'inserted' : 'preserved'}`);
    console.log(`Demo username: ${result.username}; URL: /survey/${result.surveyId}`);
    console.log('Existing credentials and survey fields are never updated.');
  } catch (error) {
    // Driver messages may contain credentials; only print known local validation errors.
    const message = typeof error?.message === 'string' ? error.message : '';
    console.error(/^(SEED_PASSWORD must|Seed identity conflict:|Missing required configuration:|(?:PORT|NODE_ENV|SESSION_SECRET|MONGODB_DB|MONGODB_URI) must)/.test(message)
      ? message : 'Seed failed: MongoDB connection, indexes or identity conflict; no existing data overwritten');
    process.exitCode = 1;
  }
}
