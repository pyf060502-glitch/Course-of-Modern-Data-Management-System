import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { registerAuth } from '../src/routes/auth.js';
import { registerSurveyRoutes } from '../src/routes/surveys.js';
import { createTestDatabase } from './helpers/database.js';

test('survey author APIs with real MongoDB, sessions and CSRF', async (t) => {
  const fixture = await createTestDatabase();
  const app = createApp({
    ...fixture,
    registerRoutes(app, dependencies) {
      registerAuth(app, dependencies);
      registerSurveyRoutes(app, { db: dependencies.db });
    },
  });
  async function account(username) {
    const agent = request.agent(app);
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
    const credentials = { username, password: 'surveys-test-password' };
    await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send(credentials).expect(201);
    const login = await agent.post('/api/auth/login')
      .set('X-CSRF-Token', csrf).send(credentials).expect(200);
    return { agent, csrf: login.body.data.csrfToken, user: login.body.data.user };
  }
  function call(account, method, path, body) {
    const req = account.agent[method](path).set('X-CSRF-Token', account.csrf);
    return body === undefined ? req : req.send(body);
  }
  try {
    await app.locals.sessionStoreReady;
    const owner = await account('survey_owner');
    const other = await account('survey_other');
    const base = '/api/surveys';
    const create = async (body = { title: 'Survey' }, actor = owner) =>
      (await call(actor, 'post', base, body).expect(201)).body.data;
    const add = async (id, question) =>
      (await call(owner, 'post', `${base}/${id}/questions`, { question }).expect(201)).body.data.question;

    await t.test('creation defaults, exact settings, list pagination and owner isolation', async () => {
      const first = await create({ title: '  First  ', description: '  Description  ' });
      assert.equal(first.title, 'First');
      assert.equal(first.description, 'Description');
      assert.equal(first.status, 'draft');
      assert.equal(first.effectiveStatus, 'draft');
      assert.equal(first.allowAnonymous, false);
      assert.equal(first.allowMultipleResponses, true);
      assert.equal(first.deadline, null);
      assert.deepEqual(first.questions, []);
      assert.deepEqual(first.jumpRules, []);
      assert.equal(first.publicUrl, `/survey/${first.id}`);
      const stored = await fixture.db.collection('surveys').findOne({ _id: new ObjectId(first.id) });
      assert(stored.ownerId instanceof ObjectId);
      assert.equal(stored.ownerId.toHexString(), owner.user.id);
      assert(stored.createdAt instanceof Date);
      assert.equal(Object.hasOwn(stored, 'version'), false);
      await create({ title: 'Second' });
      await create({ title: 'Other private' }, other);
      const page1 = (await owner.agent.get(`${base}/mine?page=1&pageSize=1`).expect(200)).body.data;
      const page2 = (await owner.agent.get(`${base}/mine?page=2&pageSize=1`).expect(200)).body.data;
      assert.equal(page1.total, 2);
      assert.equal(page1.totalPages, 2);
      assert.notEqual(page1.items[0].id, page2.items[0].id);
      assert.equal((await other.agent.get(`${base}/mine`).expect(200)).body.data.total, 1);
      assert.equal((await owner.agent.get(`${base}/mine?page=20`).expect(200)).body.data.items.length, 0);
      await owner.agent.get(`${base}/${first.id}`).expect(200);
      for (const query of ['page=0', 'page=-1', 'page=1.2', 'pageSize=101', 'pageSize=0',
        'unknown=1', 'page=1&page=2', 'page=9007199254740991&pageSize=100']) {
        await owner.agent.get(`${base}/mine?${query}`).expect(400);
      }
      await call(owner, 'patch', `${base}/${first.id}`, {
        title: 'Changed', description: '', allowAnonymous: true,
        allowMultipleResponses: false, deadline: '2035-01-01T00:00:00Z',
      }).expect(200);
      const updated = (await owner.agent.get(`${base}/${first.id}`).expect(200)).body.data;
      assert.equal(updated.allowAnonymous, true);
      assert.equal(updated.allowMultipleResponses, false);
      assert.equal(updated.deadline, '2035-01-01T00:00:00.000Z');
      await call(owner, 'patch', `${base}/${first.id}`, { deadline: null }).expect(200);
    });

    await t.test('four question types, stable options, replacement validation and complete sorting', async () => {
      const survey = await create();
      const path = `${base}/${survey.id}`;
      const single = await add(survey.id, { title: 'Single', type: 'single',
        options: [{ label: 'A' }, { label: 'B' }] });
      const multiple = await add(survey.id, { title: 'Multiple', type: 'multiple', required: true,
        options: [{ label: 'A' }, { label: 'B' }], validation: { exactSelections: 1 } });
      const text = await add(survey.id, { title: 'Text', type: 'text',
        validation: { minLength: 1, maxLength: 10 } });
      const number = await add(survey.id, { title: 'Number', type: 'number',
        validation: { min: 0, max: 10, integer: true } });
      const changed = (await call(owner, 'patch', `${path}/questions/${single.id}`, {
        question: { options: [{ id: single.options[1].id, label: 'Renamed' },
          { id: single.options[0].id, label: 'A' }, { label: 'New' }] },
      }).expect(200)).body.data.question;
      assert.equal(changed.id, single.id);
      assert.equal(changed.options[0].id, single.options[1].id);
      assert.notEqual(changed.options[2].id, single.options[0].id);
      const changedText = (await call(owner, 'patch', `${path}/questions/${text.id}`, {
        question: { validation: { maxLength: 20 } },
      }).expect(200)).body.data.question;
      assert.deepEqual(changedText.validation, { maxLength: 20 });
      await call(owner, 'patch', `${path}/questions/${single.id}`, {
        question: { options: [{ id: multiple.options[0].id, label: 'Foreign' }] },
      }).expect(400);
      const ids = [number.id, text.id, single.id, multiple.id];
      const sorted = (await call(owner, 'put', `${path}/questions/order`,
        { questionIds: ids }).expect(200)).body.data.questions;
      assert.deepEqual(sorted.map((q) => q.id), ids);
      assert.deepEqual(sorted.map((q) => q.order), [1, 2, 3, 4]);
      for (const questionIds of [[single.id], [single.id, single.id, text.id, number.id],
        [randomUUID(), multiple.id, text.id, number.id]]) {
        await call(owner, 'put', `${path}/questions/order`, { questionIds }).expect(400);
      }
      await call(owner, 'delete', `${path}/questions/${text.id}`).expect(200);
      const detail = (await owner.agent.get(path).expect(200)).body.data;
      assert.deepEqual(detail.questions.map((q) => q.order), [1, 2, 3]);
      await call(owner, 'delete', `${path}/questions/${text.id}`).expect(404);
    });

    await t.test('rules retain IDs, reject forward reorder, and clear removed options and questions', async () => {
      const survey = await create();
      const path = `${base}/${survey.id}`;
      const first = await add(survey.id, { title: 'First', type: 'single',
        options: [{ label: 'A' }, { label: 'B' }] });
      const second = await add(survey.id, { title: 'Second', type: 'number' });
      const third = await add(survey.id, { title: 'Third', type: 'text' });
      const initial = [
        { sourceQuestionId: first.id, operator: 'equals', value: first.options[0].id,
          targetQuestionId: third.id, priority: 0 },
        { sourceQuestionId: first.id, operator: 'equals', value: first.options[1].id,
          targetQuestionId: second.id, priority: 1 },
        { sourceQuestionId: second.id, operator: 'greater_than', value: 0,
          targetQuestionId: third.id, priority: 0 },
      ];
      const rules = (await call(owner, 'put', `${path}/jump-rules`,
        { rules: initial }).expect(200)).body.data.rules;
      const retained = (await call(owner, 'put', `${path}/jump-rules`,
        { rules }).expect(200)).body.data.rules;
      assert.deepEqual(retained, rules);
      await call(owner, 'put', `${path}/questions/order`,
        { questionIds: [third.id, first.id, second.id] }).expect(400);
      const unchanged = (await owner.agent.get(path).expect(200)).body.data;
      assert.deepEqual(unchanged.questions.map((q) => q.id), [first.id, second.id, third.id]);
      const changed = (await call(owner, 'patch', `${path}/questions/${first.id}`, {
        question: { options: [{ id: first.options[1].id, label: 'B retained' }] },
      }).expect(200)).body.data;
      assert.deepEqual(changed.removedRuleIds, [rules[0].id]);
      const removed = (await call(owner, 'delete', `${path}/questions/${second.id}`)
        .expect(200)).body.data;
      assert.deepEqual(removed.removedRuleIds, [rules[1].id, rules[2].id]);
      assert.deepEqual((await owner.agent.get(path).expect(200)).body.data.jumpRules, []);
      const endRule = (await call(owner, 'put', `${path}/jump-rules`, { rules: [{
        sourceQuestionId: first.id, operator: 'equals', value: first.options[1].id,
        targetQuestionId: 'END', priority: 0,
      }] }).expect(200)).body.data.rules[0];
      const typeChange = (await call(owner, 'patch', `${path}/questions/${first.id}`,
        { question: { type: 'text' } }).expect(200)).body.data;
      assert.deepEqual(typeChange.removedRuleIds, [endRule.id]);
      assert.deepEqual(typeChange.question.options, []);
      await call(owner, 'put', `${path}/jump-rules`, { rules: initial }).expect(400);
    });

    await t.test('publish validation, structural locks, metadata updates and idempotent close', async () => {
      const survey = await create();
      const path = `${base}/${survey.id}`;
      await call(owner, 'post', `${path}/close`).expect(409);
      await call(owner, 'post', `${path}/publish`).expect(400);
      const q = await add(survey.id, { title: 'Question', type: 'text' });
      await call(owner, 'patch', path, { deadline: '2000-01-01T00:00:00Z' }).expect(200);
      await call(owner, 'post', `${path}/publish`).expect(400);
      await call(owner, 'patch', path, { deadline: null }).expect(200);
      const published = (await call(owner, 'post', `${path}/publish`).expect(200)).body.data;
      assert.equal(published.status, 'published');
      assert.equal(published.effectiveStatus, 'published');
      assert(published.publishedAt);
      const republished = (await call(owner, 'post', `${path}/publish`).expect(200)).body.data;
      assert.equal(republished.publishedAt, published.publishedAt);
      assert.equal(republished.updatedAt, published.updatedAt);
      const locks = [
        ['patch', path, { allowAnonymous: true }],
        ['patch', path, { allowMultipleResponses: false }],
        ['post', `${path}/questions`, { question: { title: 'New', type: 'text' } }],
        ['patch', `${path}/questions/${q.id}`, { question: { title: 'Changed' } }],
        ['delete', `${path}/questions/${q.id}`],
        ['put', `${path}/questions/order`, { questionIds: [q.id] }],
        ['put', `${path}/jump-rules`, { rules: [] }],
      ];
      for (const [method, url, body] of locks) await call(owner, method, url, body).expect(409);
      await call(owner, 'patch', path, { title: 'Published title', description: 'Updated',
        deadline: '2035-01-01T00:00:00Z' }).expect(200);
      await call(owner, 'patch', path, { deadline: '2000-01-01T00:00:00Z' }).expect(400);
      await call(owner, 'patch', path, { deadline: null }).expect(200);
      const closed = (await call(owner, 'post', `${path}/close`).expect(200)).body.data;
      const reclosed = (await call(owner, 'post', `${path}/close`).expect(200)).body.data;
      assert.equal(closed.status, 'closed');
      assert.equal(reclosed.closedAt, closed.closedAt);
      assert.equal(reclosed.updatedAt, closed.updatedAt);
      await call(owner, 'patch', path, { title: 'No reopen' }).expect(409);
      await call(owner, 'post', `${path}/publish`).expect(409);
      assert.deepEqual((await owner.agent.get(path).expect(200)).body.data.questions, published.questions);
    });

    await t.test('deadline effective status is live without persisted status mutation', async () => {
      const survey = await create();
      const path = `${base}/${survey.id}`;
      await add(survey.id, { title: 'Question', type: 'number' });
      await call(owner, 'post', `${path}/publish`).expect(200);
      await fixture.db.collection('surveys').updateOne({ _id: new ObjectId(survey.id) },
        { $set: { deadline: new Date(0) } });
      const expired = (await owner.agent.get(path).expect(200)).body.data;
      assert.equal(expired.status, 'published');
      assert.equal(expired.effectiveStatus, 'expired');
      const listed = (await owner.agent.get(`${base}/mine`).expect(200)).body.data.items;
      assert.equal(listed.find((s) => s.id === survey.id).effectiveStatus, 'expired');
      await call(owner, 'patch', path, { deadline: '2035-01-01T00:00:00Z' }).expect(409);
      await call(owner, 'post', `${path}/publish`).expect(409);
      const closed = (await call(owner, 'post', `${path}/close`).expect(200)).body.data;
      assert.equal(closed.effectiveStatus, 'closed');
      assert.equal(closed.status, 'closed');
      assert.equal((await fixture.db.collection('surveys').findOne({
        _id: new ObjectId(survey.id),
      })).status, 'closed');
    });

    await t.test('all author actions isolate owners, require authentication and reject unsafe requests', async () => {
      const survey = await create();
      const path = `${base}/${survey.id}`;
      const q = await add(survey.id, { title: 'Question', type: 'text' });
      const actions = [
        ['get', path], ['patch', path, { title: 'Stolen' }], ['delete', path],
        ['post', `${path}/publish`], ['post', `${path}/close`],
        ['post', `${path}/questions`, { question: { title: 'Stolen', type: 'text' } }],
        ['patch', `${path}/questions/${q.id}`, { question: { title: 'Stolen' } }],
        ['delete', `${path}/questions/${q.id}`],
        ['put', `${path}/questions/order`, { questionIds: [q.id] }],
        ['put', `${path}/jump-rules`, { rules: [] }],
      ];
      const anonymous = { agent: request.agent(app) };
      anonymous.csrf = (await anonymous.agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
      for (const [method, url, body] of actions) {
        await call(other, method, url, body).expect(404);
        await call(anonymous, method, url, body).expect(401);
      }
      await call(anonymous, 'get', `${base}/mine`).expect(401);
      await call(anonymous, 'post', base, { title: 'Anonymous' }).expect(401);
      await owner.agent.post(base).send({ title: 'Missing CSRF' }).expect(403);
      for (const body of [{ title: 'X', ownerId: owner.user.id }, { title: { $ne: null } },
        { title: 'X', status: 'published' }, { title: 'X', questions: [] },
        { title: 'X', allowAnonymous: 'true' }, { title: 'X', deadline: 123 },
        { title: 'X', deadline: '2035-02-30T00:00:00Z' }, {}, { title: 'x'.repeat(201) }]) {
        await call(owner, 'post', base, body).expect(400);
      }
      for (const body of [{ status: 'published' }, { ownerId: other.user.id },
        { jumpRules: [] }, { updatedAt: new Date().toISOString() }, {}]) {
        await call(owner, 'patch', path, body).expect(400);
      }
      await owner.agent.get(`${base}/bad-id`).expect(400);
      await owner.agent.get(`${path}?unknown=1`).expect(400);
      await call(owner, 'post', `${path}/publish`, { status: 'published' }).expect(400);
      await call(owner, 'post', `${path}/questions`,
        { title: 'Wrong envelope', type: 'text' }).expect(400);
      await call(owner, 'post', `${path}/questions`,
        { question: { title: 'X', type: 'text', id: randomUUID() } }).expect(400);
      await call(owner, 'patch', `${path}/questions/${q.id}`,
        { question: { order: 4 } }).expect(400);
      await call(owner, 'put', `${path}/questions/order`, { ids: [q.id] }).expect(400);
      await call(owner, 'put', `${path}/jump-rules`, { jumpRules: [] }).expect(400);
      await call(owner, 'delete', path, { force: true }).expect(400);
      assert.equal((await owner.agent.get(path).expect(200)).body.data.status, 'draft');
    });

    await t.test('normal cascade deletion removes associated answers only', async () => {
      const survey = await create();
      const keep = await create();
      const surveyId = new ObjectId(survey.id);
      const keepId = new ObjectId(keep.id);
      await fixture.db.collection('responses').insertMany([
        { surveyId, respondentId: new ObjectId(owner.user.id), submittedAt: new Date() },
        { surveyId, respondentId: null, anonymous: true, submittedAt: new Date() },
        { surveyId: keepId, submittedAt: new Date() },
      ]);
      const result = (await call(owner, 'delete', `${base}/${survey.id}`).expect(200)).body.data;
      assert.deepEqual(result, { deleted: true, deletedResponses: 2 });
      assert.equal(await fixture.db.collection('responses').countDocuments({ surveyId }), 0);
      assert.equal(await fixture.db.collection('responses').countDocuments({ surveyId: keepId }), 1);
      assert.equal(await fixture.db.collection('surveys').countDocuments({ _id: surveyId }), 0);
      await owner.agent.get(`${base}/${survey.id}`).expect(404);
      await call(owner, 'delete', `${base}/${survey.id}`).expect(404);
      await call(owner, 'delete', `${base}/${keep.id}`).expect(200);
      assert.equal(await fixture.db.collection('responses').countDocuments({ surveyId: keepId }), 0);
    });
  } finally {
    await app.locals.sessionStore?.close();
    await fixture.cleanup();
  }
});

test('default app wires all API modules and anonymous static page shells', async () => {
  const fixture = await createTestDatabase();
  const app = createApp(fixture);
  try {
    await app.locals.sessionStoreReady;
    await request(app).get('/').expect(302).expect('Location', '/surveys');
    const id = new ObjectId().toHexString();
    for (const path of ['/login', '/register', '/surveys', `/surveys/${id}/edit`,
      `/surveys/${id}/statistics`, `/survey/${id}`, `/survey/${id}/complete`]) {
      const response = await request(app).get(path).expect(200);
      assert.match(response.headers['content-type'], /text\/html/);
      assert.match(response.text, /<!doctype html>/i);
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.text.includes('passwordHash'), false);
    }
    await request(app).get('/js/common.js').expect(200);
    await request(app).get('/api/surveys/mine').expect(401);
    await request(app).get(`/api/surveys/${id}/statistics`).expect(401);
    await request(app).get(`/api/public/surveys/${id}`).expect(404);
    await request(app).post(`/api/public/surveys/${id}/responses`).send({ answers: [] }).expect(403);
    const agent = request.agent(app);
    const token = (await agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
    const credentials = { username: 'default_wiring', password: 'default-wiring-password' };
    await agent.post('/api/auth/register').set('X-CSRF-Token', token).send(credentials).expect(201);
    const login = (await agent.post('/api/auth/login')
      .set('X-CSRF-Token', token).send(credentials).expect(200)).body.data;
    const survey = (await agent.post('/api/surveys').set('X-CSRF-Token', login.csrfToken)
      .send({ title: 'Default wiring' }).expect(201)).body.data;
    await agent.get(`/api/surveys/${survey.id}`).expect(200);
    const question = (await agent.post(`/api/surveys/${survey.id}/questions`)
      .set('X-CSRF-Token', login.csrfToken)
      .send({ question: { title: 'Question', type: 'text' } }).expect(201)).body.data.question;
    await agent.post(`/api/surveys/${survey.id}/publish`)
      .set('X-CSRF-Token', login.csrfToken).expect(200);
    await request(app).get(`/api/public/surveys/${survey.id}`).expect(200);
    const statistics = (await agent.get(`/api/surveys/${survey.id}/statistics`).expect(200)).body.data;
    assert.equal(statistics.totalResponses, 0);
    await agent.get(`/api/surveys/${survey.id}/statistics/questions/${question.id}`).expect(200);
  } finally {
    await app.locals.sessionStore?.close();
    await fixture.cleanup();
  }
});
