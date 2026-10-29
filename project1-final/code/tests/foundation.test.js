import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { MongoClient } from 'mongodb';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/db/connection.js';
import { ensureIndexes } from '../src/db/indexes.js';
import { startServer } from '../src/server.js';
import { HttpError, sendData } from '../src/middleware/errors.js';
import {
  assertAllowedFields, parseObjectId, assertString, assertBoolean, assertFiniteNumber,
} from '../src/validators/basic.js';
import { createTestDatabase, testDatabaseConfig } from './helpers/database.js';

const validEnv = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DB: 'survey_system',
  SESSION_SECRET: randomUUID(),
};

test('configuration rejects missing, invalid and placeholder settings without exposing values', () => {
  assert.equal(loadConfig(validEnv).port, 3000);
  assert.equal(loadConfig(validEnv).jsonLimit, '100kb');
  for (const key of Object.keys(validEnv)) {
    const env = { ...validEnv };
    delete env[key];
    assert.throws(() => loadConfig(env), new RegExp(key));
  }
  for (const port of ['0', '65536', '3.5', '3e3', '-1', '']) {
    assert.throws(() => loadConfig({ ...validEnv, PORT: port }), /PORT/);
  }
  for (const patch of [
    { NODE_ENV: 'invalid' }, { MONGODB_DB: 'admin' }, { MONGODB_DB: 'a.b' },
    { MONGODB_URI: 'https://secret@example.com' }, { SESSION_SECRET: 'short' },
    { SESSION_SECRET: 'REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARACTERS' },
  ]) assert.throws(() => loadConfig({ ...validEnv, ...patch }));
  assert.equal(loadConfig({ ...validEnv, NODE_ENV: 'production', PORT: '8080' }).port, 8080);
});

test('test database guards reject business/system names and unsafe URI database paths', () => {
  for (const env of [
    { TEST_MONGODB_DB: 'survey_system' },
    { TEST_MONGODB_DB: 'admin' },
    { TEST_MONGODB_DB: 'survey_test_business', MONGODB_DB: 'survey_test_business' },
    { TEST_MONGODB_URI: 'mongodb://127.0.0.1:27017/survey_system' },
    { TEST_MONGODB_URI: 'mongodb://127.0.0.1:27017/admin' },
    { TEST_MONGODB_URI: 'mongodb://127.0.0.1:27017/%73urvey_system' },
    { TEST_MONGODB_URI: 'http://127.0.0.1:27017' },
  ]) assert.throws(() => testDatabaseConfig(env));
  const first = testDatabaseConfig({});
  const second = testDatabaseConfig({});
  assert.match(first.mongodbDb, /^survey_test_integration_[a-f0-9]{20}$/);
  assert.notEqual(first.mongodbDb, second.mongodbDb);
});

test('basic validators enforce IDs, field whitelist, types and Unicode length', () => {
  const id = '0123456789abcdef01234567';
  assert.equal(parseObjectId(id).toHexString(), id);
  for (const input of ['bad', 'g'.repeat(24), { $ne: null }, null, 123]) {
    assert.throws(() => parseObjectId(input, 'surveyId'), HttpError);
  }
  for (const input of [
    { unknown: true }, { title: { $ne: null } }, { title: { 'a.b': 1 } },
    JSON.parse('{"__proto__":{}}'), [], null,
  ]) assert.throws(() => assertAllowedFields(input, ['title']), HttpError);
  assert.throws(() => assertString({ $gt: '' }, 'title'), HttpError);
  assert.equal(assertString('  😀  ', 'title', { min: 1, max: 1 }), '😀');
  assert.equal(assertString(' pass ', 'password', { trim: false }), ' pass ');
  assert.equal(assertBoolean(false, 'flag'), false);
  assert.throws(() => assertBoolean('false', 'flag'), HttpError);
  assert.equal(assertFiniteNumber(0, 'number'), 0);
  for (const value of ['1', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertFiniteNumber(value, 'number'), HttpError);
  }
  assert.throws(() => assertFiniteNumber(1.5, 'number', { integer: true }), HttpError);
});

test('real MongoDB ping, idempotent indexes, username uniqueness and concurrent partial uniqueness', async () => {
  const fixture = await createTestDatabase();
  try {
    const { db, config } = fixture;
    assert.equal((await db.command({ ping: 1 })).ok, 1);
    await ensureIndexes(db);
    const users = db.collection('users');
    await users.insertOne({ usernameNormalized: 'alice' });
    await assert.rejects(users.insertOne({ usernameNormalized: 'alice' }), { code: 11000 });
    const userIndex = (await users.listIndexes().toArray())
      .find((index) => index.name === 'users_username_normalized_unique');
    assert.equal(userIndex.unique, true);
    assert.deepEqual(userIndex.key, { usernameNormalized: 1 });
    const surveyIndexes = await db.collection('surveys').listIndexes().toArray();
    assert.deepEqual(surveyIndexes.find((index) => index.name === 'surveys_owner_created').key,
      { ownerId: 1, createdAt: -1 });
    assert.equal(surveyIndexes.some((index) => index.expireAfterSeconds !== undefined), false);
    const responses = db.collection('responses');
    const indexes = await responses.listIndexes().toArray();
    assert.deepEqual(indexes.find((index) => index.name === 'responses_survey_submitted').key,
      { surveyId: 1, submittedAt: -1 });
    assert.deepEqual(indexes.find((index) => index.name === 'responses_survey_respondent').key,
      { surveyId: 1, respondentId: 1 });
    const partial = indexes.find((index) => index.name === 'responses_single_response_unique');
    assert.equal(partial.unique, true);
    assert.deepEqual(partial.partialFilterExpression, { singleResponseKey: { $type: 'string' } });
    await responses.insertMany([{}, {}, { singleResponseKey: null }, { singleResponseKey: null }]);
    const results = await Promise.allSettled([
      responses.insertOne({ singleResponseKey: 'survey:user' }),
      responses.insertOne({ singleResponseKey: 'survey:user' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 11000);
    const second = await connectDatabase(config);
    try {
      assert.equal(await second.db.collection('users').countDocuments({ usernameNormalized: 'alice' }), 1);
    } finally {
      await second.client.close();
    }
    console.log('MongoDB ping ok=1; business indexes verified; concurrent unique insert=1 success/1 E11000');
  } finally {
    await fixture.cleanup();
  }
  const inspector = new MongoClient(fixture.config.mongodbUri);
  try {
    await inspector.connect();
    const names = await inspector.db('admin').admin().listDatabases({ nameOnly: true });
    assert.equal(names.databases.some((db) => db.name === fixture.config.mongodbDb), false);
    console.log('Dedicated MongoDB test database cleanup verified');
  } finally {
    await inspector.close();
  }
});

test('health and HTTP validation use real MongoDB; production errors never leak internals', async () => {
  const fixture = await createTestDatabase();
  try {
    const config = { ...fixture.config, nodeEnv: 'production' };
    const app = createApp({
      ...fixture, config,
      registerRoutes(app) {
        app.post('/test/input/:id', (req, res) => {
          parseObjectId(req.params.id, 'id');
          assertAllowedFields(req.body, ['title']);
          return sendData(res, { title: assertString(req.body.title, 'title') });
        });
        app.get('/test/failure', () => { throw new Error('secret-password-stack'); });
        app.get('/test/http-failure', () => {
          throw new HttpError(500, 'PRIVATE_CODE', 'private-driver-message', { secret: true });
        });
      },
    });
    const health = await request(app).get('/api/health').expect(200);
    assert.deepEqual(health.body, { data: { status: 'ok', database: 'connected' } });
    assert.equal(health.headers['x-powered-by'], undefined);
    await request(app).get('/api/health?unknown=1').expect(400);
    await request(app).get('/api/health').send({ unknown: 1 }).expect(400);
    const id = '0123456789abcdef01234567';
    await request(app).post(`/test/input/${id}`).send({ title: 'ok' }).expect(200);
    await request(app).post('/test/input/invalid').send({ title: 'ok' }).expect(400);
    for (const body of [{ title: 'ok', unknown: true }, { title: { $ne: null } }, { title: {} }, []]) {
      await request(app).post(`/test/input/${id}`).send(body).expect(400);
    }
    const malformed = await request(app).post(`/test/input/${id}`)
      .set('Content-Type', 'application/json').send('{"title":').expect(400);
    assert.equal(malformed.body.error.code, 'INVALID_JSON');
    const large = await request(app).post(`/test/input/${id}`)
      .send({ title: 'a'.repeat(110000) }).expect(413);
    assert.equal(large.body.error.code, 'PAYLOAD_TOO_LARGE');
    const absent = await request(app).get('/missing').expect(404);
    assert.equal(absent.body.error.code, 'NOT_FOUND');
    for (const path of ['/test/failure', '/test/http-failure']) {
      const failure = await request(app).get(path).expect(500);
      assert.deepEqual(failure.body, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
    await fixture.client.close();
    const down = await request(app).get('/api/health').expect(503);
    assert.deepEqual(down.body, { error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable' } });
  } finally {
    // The health outage test closes its client; reconnect only to clean the owned database.
    await fixture.client.connect();
    await fixture.cleanup();
  }
});

test('actual HTTP listener starts, serves health and shuts down cleanly', async () => {
  const fixture = await createTestDatabase();
  let runtime;
  try {
    runtime = await startServer(fixture.config);
    const health = await request(runtime.server).get('/api/health').expect(200);
    assert.equal(health.body.data.status, 'ok');
    await runtime.close();
    await runtime.close();
    assert.equal(runtime.server.listening, false);
    console.log('Actual HTTP listener health=200; graceful shutdown verified');
  } finally {
    if (runtime) await runtime.close();
    await fixture.cleanup();
  }
});

test('unreachable MongoDB rejects connection rather than falling back to memory', async () => {
  await assert.rejects(connectDatabase({ mongodbUri: validEnv.MONGODB_URI }), /MONGODB_DB/);
  await assert.rejects(connectDatabase({ mongodbDb: 'survey_system' }), /MONGODB_URI/);
  await assert.rejects(connectDatabase({
    mongodbUri: 'mongodb://127.0.0.1:1', mongodbDb: 'survey_test_unavailable', mongoTimeoutMS: 200,
  }));
});

test('server CLI fails clearly for missing config and unavailable database', () => {
  const env = { ...process.env, DOTENV_CONFIG_PATH: 'Z:/nonexistent-survey-test.env' };
  for (const key of ['MONGODB_URI', 'MONGODB_DB', 'SESSION_SECRET']) delete env[key];
  const missing = spawnSync(process.execPath, ['src/server.js'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing required configuration: MONGODB_URI/);
  const unavailable = spawnSync(process.execPath, ['src/server.js'], {
    env: { ...env, ...validEnv, MONGODB_URI: 'mongodb://127.0.0.1:1' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /Startup failed: MongoDB/);
  assert.equal(unavailable.stderr.includes(validEnv.SESSION_SECRET), false);
  console.log(`CLI missing config exit=${missing.status}; unavailable MongoDB exit=${unavailable.status}`);
});
