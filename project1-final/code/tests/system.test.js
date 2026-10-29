import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BSON, MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { seedDemo, DEMO_USER_ID, DEMO_SURVEY_ID, DEMO_USERNAME, SEED_TAG } from '../scripts/seed.js';
import { normalizeQuestion, validateQuestions, validateAnswer, LIMITS } from '../src/validators/questions.js';
import { END, getNextQuestion, validateRules, validateSubmission } from '../src/services/jump.js';
import { createTestDatabase } from './helpers/database.js';

test('system logic accepts exact capacity limits and rejects one beyond them', () => {
  const questions = Array.from({ length: LIMITS.questions }, (_, index) =>
    normalizeQuestion({
      title: 'x'.repeat(LIMITS.title), type: 'single',
      options: Array.from({ length: LIMITS.options }, (_, option) => ({ label: `Option ${option}` })),
    }, { order: index + 1 }));
  assert.equal(validateQuestions(questions).length, 100);
  assert.throws(() => validateQuestions([...questions, questions[0]]), { status: 400 });
  const rules = Array.from({ length: LIMITS.jumpRules }, (_, index) => ({
    sourceQuestionId: questions[0].id, targetQuestionId: END,
    operator: 'equals', value: questions[0].options[index % LIMITS.options].id,
    priority: index,
  }));
  assert.equal(validateRules(questions, rules).length, 500);
  assert.throws(() => validateRules(questions, [...rules, { ...rules[0], priority: 500 }]),
    { status: 400 });
  const text = normalizeQuestion({ title: 'Text', type: 'text', required: true });
  assert.equal(validateAnswer(text, 'x'.repeat(LIMITS.textAnswer)).length, 10000);
  assert.throws(() => validateAnswer(text, 'x'.repeat(LIMITS.textAnswer + 1)), { status: 422 });
  const snapshot = JSON.stringify({ questions, rules });
  const survey = { questions, jumpRules: rules };
  const answer = { questionId: questions[0].id, value: questions[0].options[0].id };
  assert.deepEqual(validateSubmission(survey, [answer]), { answers: [answer], path: [questions[0].id] });
  assert.equal(JSON.stringify({ questions, rules }), snapshot);
});

async function startChild(config) {
  const serverUrl = new URL('../src/server.js', import.meta.url).href;
  const program = `
    import { startServer } from ${JSON.stringify(serverUrl)};
    try {
      const runtime = await startServer(JSON.parse(process.env.SYSTEM_TEST_CONFIG));
      process.on('message', async (message) => {
        if (message === 'stop') {
          await runtime.close();
          process.disconnect();
        }
      });
      process.send({ port: runtime.server.address().port });
    } catch {
      process.exit(1);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    env: { ...process.env, SYSTEM_TEST_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(([code]) => { throw new Error(`HTTP child exited before ready (${code})`); }),
    ]);
    assert.equal(typeof ready.port, 'number');
    return {
      base: `http://127.0.0.1:${ready.port}`,
      async stop() {
        if (child.exitCode === null && child.signalCode === null && child.connected) {
          child.send('stop');
        }
        const timeout = setTimeout(() => child.kill(), 10000);
        try {
          const [code, signal] = await exited;
          assert.equal(signal, null);
          assert.equal(code, 0);
          assert.equal(output, '');
        } finally {
          clearTimeout(timeout);
        }
      },
    };
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

test('real HTTP child restart preserves users, surveys, responses and valid MongoDB sessions', {
  timeout: 60000,
}, async () => {
  const fixture = await createTestDatabase();
  let runtime;
  let cookie;
  let token;
  async function api(method, path, body, status = 200) {
    const response = await fetch(`${runtime.base}${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { 'X-CSRF-Token': token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return result.data;
  }
  try {
    runtime = await startChild(fixture.config);
    assert.equal((await api('GET', '/api/health')).database, 'connected');
    token = (await api('GET', '/api/auth/csrf')).csrfToken;
    const credentials = { username: 'system_restart', password: 'system-test-password' };
    await api('POST', '/api/auth/register', credentials, 201);
    const login = await api('POST', '/api/auth/login', credentials);
    token = login.csrfToken;
    const userId = login.user.id;
    const survey = await api('POST', '/api/surveys', { title: 'HTTP restart persistence' }, 201);
    const path = `/api/surveys/${survey.id}`;
    const { question } = await api('POST', `${path}/questions`, {
      question: { title: 'Text', type: 'text', required: true },
    }, 201);
    await api('POST', `${path}/publish`);
    const submission = await api('POST', `/api/public/surveys/${survey.id}/responses`, {
      answers: [{ questionId: question.id, value: '  persisted answer  ' }],
    }, 201);
    const before = {};
    for (const name of ['users', 'surveys', 'responses', 'sessions']) {
      before[name] = await fixture.db.collection(name).find().sort({ _id: 1 }).toArray();
      assert.equal(before[name].length, 1);
    }
    assert.equal(before.responses[0].respondentId.toHexString(), userId);
    assert.equal(before.responses[0].anonymous, false);
    assert.deepEqual(before.responses[0].answers,
      [{ questionId: question.id, value: 'persisted answer' }]);
    assert.deepEqual(before.responses[0].path, [question.id]);
    assert.equal(before.responses[0]._id.toHexString(), submission.id);
    assert.ok(before.responses[0].submittedAt instanceof Date);
    await runtime.stop();
    runtime = undefined;
    for (const name of Object.keys(before)) {
      assert.deepEqual(await fixture.db.collection(name).find().sort({ _id: 1 }).toArray(), before[name]);
    }
    runtime = await startChild(fixture.config);
    for (const name of Object.keys(before)) {
      assert.deepEqual(await fixture.db.collection(name).find().sort({ _id: 1 }).toArray(), before[name]);
    }
    assert.equal((await api('GET', '/api/auth/me')).user.id, userId);
    assert.equal((await api('GET', path)).questions[0].id, question.id);
    const sessionIndex = (await fixture.db.collection('sessions').listIndexes().toArray())
      .find((index) => index.key.expires === 1);
    assert.equal(sessionIndex.expireAfterSeconds, 0);
    assert.equal((await fixture.db.collection('surveys').listIndexes().toArray())
      .some((index) => index.expireAfterSeconds !== undefined), false);
    await fixture.db.collection('sessions').updateOne({ _id: before.sessions[0]._id },
      { $set: { expires: new Date(0) } });
    assert.equal((await api('GET', '/api/auth/me')).user, null);
    await api('GET', path, undefined, 401);
    assert.equal(await fixture.db.collection('responses').countDocuments({
      surveyId: new ObjectId(survey.id),
    }), 1);
    console.log('Real HTTP child stop/restart: four MongoDB collections preserved; Cookie authenticates; expired session rejected');
  } finally {
    try {
      if (runtime) await runtime.stop();
    } finally {
      await fixture.cleanup();
    }
  }
});

async function bsonSnapshot(db) {
  const snapshot = {};
  for (const name of ['users', 'surveys', 'responses', 'sessions']) {
    const documents = await db.collection(name).find().sort({ _id: 1 }).toArray();
    snapshot[name] = documents.map((document) => BSON.serialize(document));
  }
  return snapshot;
}

test('independent seed fixture is BSON-idempotent, preserves unrelated data and cleans only its owned database', async () => {
  const fixture = await createTestDatabase();
  const password = ' seed-system-password ';
  try {
    const userId = new ObjectId();
    const surveyId = new ObjectId();
    await fixture.db.collection('users').insertOne({
      _id: userId, username: 'real_user', usernameNormalized: 'real_user',
      passwordHash: 'untouched', createdAt: new Date(),
    });
    await fixture.db.collection('surveys').insertOne({
      _id: surveyId, ownerId: userId, title: 'Keep real survey', status: 'draft',
    });
    await fixture.db.collection('responses').insertOne({
      surveyId, respondentId: userId, answers: [], path: [], submittedAt: new Date(),
    });
    const unrelated = await bsonSnapshot(fixture.db);
    for (const invalid of [null, '', '1234567', 'x'.repeat(73), '😀'.repeat(19)]) {
      await assert.rejects(seedDemo(fixture.config, invalid), /SEED_PASSWORD must/);
      assert.deepEqual(await bsonSnapshot(fixture.db), unrelated);
    }
    const first = await seedDemo(fixture.config, password);
    assert.equal(first.userInserted, true);
    assert.equal(first.surveyInserted, true);
    const before = await bsonSnapshot(fixture.db);
    const second = await seedDemo(fixture.config, 'different-seed-password');
    assert.equal(second.userInserted, false);
    assert.equal(second.surveyInserted, false);
    assert.deepEqual(await bsonSnapshot(fixture.db), before);
    for (const name of Object.keys(unrelated)) {
      for (const document of unrelated[name]) {
        assert.ok(before[name].some((candidate) => candidate.equals(document)));
      }
    }
    const user = await fixture.db.collection('users').findOne({ _id: new ObjectId(DEMO_USER_ID) });
    const survey = await fixture.db.collection('surveys').findOne({ _id: new ObjectId(DEMO_SURVEY_ID) });
    assert.equal(user.seedTag, SEED_TAG);
    assert.equal(user.usernameNormalized, DEMO_USERNAME);
    assert.equal(await bcrypt.compare(password, user.passwordHash), true);
    assert.equal(await bcrypt.compare(password.trim(), user.passwordHash), false);
    assert.equal(await bcrypt.compare('different-seed-password', user.passwordHash), false);
    assert.equal(survey.seedTag, SEED_TAG);
    assert.ok(survey.ownerId.equals(user._id));
    assert.equal(survey.status, 'published');
    assert.equal(survey.deadline, null);
    assert.deepEqual(survey.questions.map((question) => question.type),
      ['single', 'multiple', 'number', 'text']);
    const [single, multiple, number, text] = survey.questions;
    assert.equal(getNextQuestion(survey, single.id, single.options[1].id), END);
    assert.equal(getNextQuestion(survey, multiple.id, [multiple.options[1].id]), text.id);
    assert.equal(getNextQuestion(survey, number.id, 10), END);
    assert.equal(getNextQuestion(survey, number.id, 9), text.id);
    assert.equal(await fixture.db.collection('responses').countDocuments(), 1);
    assert.equal(await fixture.db.collection('sessions').countDocuments(), 0);
    console.log(`Seed fixture ${fixture.config.mongodbDb}: two runs BSON unchanged; unrelated records preserved`);
  } finally {
    await fixture.cleanup();
  }
  const inspector = new MongoClient(fixture.config.mongodbUri);
  try {
    await inspector.connect();
    const databases = await inspector.db('admin').admin().listDatabases({ nameOnly: true });
    assert.equal(databases.databases.some((item) => item.name === fixture.config.mongodbDb), false);
    console.log('Independent seed fixture cleanup verified; no unknown databases deleted');
  } finally {
    await inspector.close();
  }
  for (const conflict of [
    { collection: 'users', document: { username: DEMO_USERNAME, usernameNormalized: DEMO_USERNAME } },
    { collection: 'users', document: { _id: new ObjectId(DEMO_USER_ID), usernameNormalized: 'real_identity' } },
    { collection: 'surveys', document: { _id: new ObjectId(DEMO_SURVEY_ID), ownerId: new ObjectId() } },
  ]) {
    const isolated = await createTestDatabase();
    try {
      await isolated.db.collection(conflict.collection).insertOne(conflict.document);
      const before = await bsonSnapshot(isolated.db);
      await assert.rejects(seedDemo(isolated.config, password), /Seed identity conflict:/);
      assert.deepEqual(await bsonSnapshot(isolated.db), before);
    } finally {
      await isolated.cleanup();
    }
  }
});

test('default app rejects every cross-owner management/statistics action without changing stored data', async () => {
  const fixture = await createTestDatabase();
  const app = createApp(fixture);
  async function actor(username) {
    const agent = request.agent(app);
    let token = (await agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
    if (username) {
      const body = { username, password: 'system-owner-password' };
      await agent.post('/api/auth/register').set('X-CSRF-Token', token).send(body).expect(201);
      token = (await agent.post('/api/auth/login').set('X-CSRF-Token', token)
        .send(body).expect(200)).body.data.csrfToken;
    }
    return { agent, token };
  }
  function call(account, method, path, body) {
    const result = account.agent[method](path).set('X-CSRF-Token', account.token);
    return body === undefined ? result : result.send(body);
  }
  try {
    await app.locals.sessionStoreReady;
    const owner = await actor('system_owner');
    const other = await actor('system_other');
    const anonymous = await actor();
    const survey = (await call(owner, 'post', '/api/surveys', { title: 'Ownership' })
      .expect(201)).body.data;
    const path = `/api/surveys/${survey.id}`;
    const { question } = (await call(owner, 'post', `${path}/questions`, {
      question: { title: 'Text', type: 'text' },
    }).expect(201)).body.data;
    const stored = await fixture.db.collection('surveys').findOne({ _id: new ObjectId(survey.id) });
    const actions = [
      ['get', path], ['patch', path, { title: 'Stolen' }], ['delete', path],
      ['post', `${path}/publish`], ['post', `${path}/close`],
      ['post', `${path}/questions`, { question: { title: 'Stolen', type: 'text' } }],
      ['patch', `${path}/questions/${question.id}`, { question: { title: 'Stolen' } }],
      ['delete', `${path}/questions/${question.id}`],
      ['put', `${path}/questions/order`, { questionIds: [question.id] }],
      ['put', `${path}/jump-rules`, { rules: [] }],
      ['get', `${path}/statistics`],
      ['get', `${path}/statistics/questions/${question.id}`],
    ];
    for (const [method, url, body] of actions) {
      const denied = await call(other, method, url, body).expect(404);
      assert.equal(denied.body.data, undefined);
      await call(anonymous, method, url, body).expect(401);
      if (method !== 'get') {
        const attempt = owner.agent[method](url);
        await (body === undefined ? attempt : attempt.send(body)).expect(403);
      }
      assert.deepEqual(await fixture.db.collection('surveys').findOne({ _id: stored._id }), stored);
    }
    await call(anonymous, 'get', '/api/surveys/mine').expect(401);
    await call(anonymous, 'post', '/api/surveys', { title: 'Denied' }).expect(401);
    assert.equal((await other.agent.get('/api/surveys/mine').expect(200)).body.data.total, 0);
    assert.equal(await fixture.db.collection('responses').countDocuments(), 0);
    console.log('Default wiring: 12 management/statistics actions reject other owner=404, anonymous=401; writes without CSRF=403');
  } finally {
    try {
      await app.locals.sessionStore?.close();
    } finally {
      await fixture.cleanup();
    }
  }
});
