import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerAuth } from '../src/routes/auth.js';
import { registerPublicRoutes } from '../src/routes/public.js';
import { registerStatisticsRoutes } from '../src/routes/statistics.js';
import { submitResponse } from '../src/services/responses.js';
import { normalizeQuestion } from '../src/validators/questions.js';
import { createTestDatabase } from './helpers/database.js';

async function setup(t) {
  const fixture = await createTestDatabase();
  const app = createApp({
    ...fixture,
    registerRoutes(app, dependencies) {
      registerAuth(app, dependencies);
      registerPublicRoutes(app, dependencies);
      registerStatisticsRoutes(app, dependencies);
    },
  });
  t.after(async () => {
    try { await app.locals.sessionStore?.close(); }
    finally { await fixture.cleanup(); }
  });
  await app.locals.sessionStoreReady;
  const agents = [];
  for (const username of ['owner', 'other']) {
    const agent = request.agent(app);
    const token = (await agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
    await agent.post('/api/auth/register').set('X-CSRF-Token', token)
      .send({ username, password: 'password123' }).expect(201);
    const login = (await agent.post('/api/auth/login').set('X-CSRF-Token', token)
      .send({ username, password: 'password123' }).expect(200)).body.data;
    agents.push({ agent, token: login.csrfToken, id: new ObjectId(login.user.id) });
  }
  const anonymous = request.agent(app);
  const anonymousToken = (await anonymous.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
  function submit(survey, answers, participant = agents[0], extra = {}) {
    return participant.agent.post(`/api/public/surveys/${survey._id}/responses`)
      .set('X-CSRF-Token', participant.token).send({ answers, ...extra });
  }
  async function survey(overrides = {}) {
    const questions = [
      normalizeQuestion({ title: 'Single', type: 'single', required: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'Zero' }] }, { order: 1 }),
      normalizeQuestion({ title: 'Multiple', type: 'multiple',
        options: [{ label: 'X' }, { label: 'Y' }],
        validation: { minSelections: 1, maxSelections: 2 } }, { order: 2 }),
      normalizeQuestion({ title: 'Text', type: 'text',
        validation: { minLength: 2, maxLength: 20 } }, { order: 3 }),
      normalizeQuestion({ title: 'Number', type: 'number',
        validation: { min: 0, max: 10, integer: true } }, { order: 4 }),
    ];
    const value = {
      _id: new ObjectId(), ownerId: agents[0].id, title: 'Survey', description: 'Description',
      status: 'published', allowAnonymous: false, allowMultipleResponses: true,
      deadline: null, questions, jumpRules: [], createdAt: new Date(), ...overrides,
    };
    await fixture.db.collection('surveys').insertOne(value);
    return value;
  }
  function answers(survey, { option = 0, multiple = [0], text = '  hello  ', number = 0 } = {}) {
    const [s, m, tx, n] = survey.questions;
    return [
      { questionId: s.id, value: s.options[option].id },
      { questionId: m.id, value: multiple.map((i) => m.options[i].id) },
      { questionId: tx.id, value: text },
      { questionId: n.id, value: number },
    ];
  }
  return { ...fixture, app, owner: agents[0], other: agents[1],
    anon: { agent: anonymous, token: anonymousToken }, submit, survey, answers };
}

test('public projection hides private data and reports draft/closed/expired/login states', async (t) => {
  const f = await setup(t);
  const survey = await f.survey({ privateSecret: 'hidden' });
  const url = `/api/public/surveys/${survey._id}`;
  const result = (await request(f.app).get(url).expect(200)).body.data;
  assert.deepEqual(Object.keys(result).sort(), [
    'id', 'title', 'description', 'status', 'effectiveStatus', 'deadline', 'allowAnonymous',
    'allowMultipleResponses', 'requiresLogin', 'canSubmit', 'submissionBlockedReason',
    'questions', 'jumpRules',
  ].sort());
  assert.equal(result.requiresLogin, true);
  assert.equal(result.canSubmit, false);
  assert.equal(result.submissionBlockedReason, 'login_required');
  assert.equal((await f.owner.agent.get(url)).body.data.canSubmit, true);
  for (const [status, deadline, effectiveStatus] of [
    ['published', new Date(0), 'expired'], ['closed', new Date(0), 'closed'],
  ]) {
    await f.db.collection('surveys').updateOne({ _id: survey._id }, { $set: { status, deadline } });
    const body = (await request(f.app).get(url).expect(200)).body.data;
    assert.equal(body.status, status);
    assert.equal(body.effectiveStatus, effectiveStatus);
    assert.equal(body.canSubmit, false);
    assert.equal(body.submissionBlockedReason, effectiveStatus);
  }
  await f.db.collection('surveys').updateOne({ _id: survey._id }, { $set: { status: 'draft' } });
  await f.owner.agent.get(url).expect(404);
  await request(f.app).get('/api/public/surveys/bad').expect(400);
  await request(f.app).get(`/api/public/surveys/${new ObjectId()}`).expect(404);
  await request(f.app).get(`${url}?ownerId=forged`).expect(400);
});

test('submissions store independent normalized responses, identity and only a generic completion URL', async (t) => {
  const f = await setup(t);
  const survey = await f.survey({ allowAnonymous: true });
  const first = (await f.submit(survey, f.answers(survey)).expect(201)).body.data;
  assert.deepEqual(Object.keys(first).sort(), ['id', 'submittedAt', 'completionUrl'].sort());
  assert.equal(first.completionUrl, `/survey/${survey._id}/complete`);
  const second = (await f.submit(survey, f.answers(survey)).expect(201)).body.data;
  assert.notEqual(first.id, second.id);
  const stored = await f.db.collection('responses').findOne({ _id: new ObjectId(first.id) });
  assert.ok(stored.respondentId.equals(f.owner.id));
  assert.ok(stored.surveyId.equals(survey._id));
  assert.equal(stored.anonymous, false);
  assert.ok(stored.submittedAt instanceof Date);
  assert.deepEqual(stored.path, survey.questions.map((q) => q.id));
  assert.equal(stored.answers[2].value, 'hello');
  assert.equal(stored.answers[3].value, 0);
  assert.equal(Object.hasOwn(stored, 'singleResponseKey'), false);
  assert.deepEqual(await f.db.collection('surveys').findOne({ _id: survey._id }), survey);
  await request(f.app).get(`/api/public/surveys/${survey._id}/responses/${first.id}`).expect(404);
});

test('anonymous participation is explicit; no-repeat always requires login and forged identity is rejected', async (t) => {
  const f = await setup(t);
  const survey = await f.survey();
  await f.submit(survey, f.answers(survey), f.anon).expect(401);
  await f.db.collection('surveys').updateOne({ _id: survey._id }, { $set: { allowAnonymous: true } });
  for (let i = 0; i < 2; i++) await f.submit(survey, f.answers(survey), f.anon).expect(201);
  const rows = await f.db.collection('responses').find({ surveyId: survey._id }).toArray();
  assert.equal(rows.length, 2);
  rows.forEach((row) => {
    assert.equal(row.respondentId, null);
    assert.equal(row.anonymous, true);
    assert.equal(Object.hasOwn(row, 'singleResponseKey'), false);
  });
  for (const extra of [
    { anonymous: true }, { respondentId: f.other.id.toString() },
    { ownerId: f.other.id.toString() }, { submittedAt: new Date().toISOString() },
    { path: survey.questions.map((q) => q.id) },
  ]) await f.submit(survey, f.answers(survey), f.owner, extra).expect(400);
  await f.db.collection('surveys').updateOne({ _id: survey._id },
    { $set: { allowMultipleResponses: false } });
  const hints = (await f.anon.agent.get(`/api/public/surveys/${survey._id}`)).body.data;
  assert.equal(hints.requiresLogin, true);
  await f.submit(survey, f.answers(survey), f.anon).expect(401);
  await request(f.app).post(`/api/public/surveys/${survey._id}/responses`)
    .send({ answers: f.answers(survey) }).expect(403);
});

test('MongoDB partial unique index makes concurrent registered submissions unique per survey/user', async (t) => {
  const f = await setup(t);
  const survey = await f.survey({ allowAnonymous: true, allowMultipleResponses: false });
  const results = await Promise.all(Array.from({ length: 6 },
    () => f.submit(survey, f.answers(survey))));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
  results.filter((r) => r.status === 409).forEach((r) =>
    assert.equal(r.body.error.code, 'ALREADY_SUBMITTED'));
  assert.equal(await f.db.collection('responses').countDocuments({ surveyId: survey._id }), 1);
  const row = await f.db.collection('responses').findOne({ surveyId: survey._id });
  assert.equal(row.singleResponseKey, `${survey._id}:${f.owner.id}`);
  await f.submit(survey, f.answers(survey), f.other).expect(201);
  const another = await f.survey({ allowMultipleResponses: false });
  await f.submit(another, f.answers(another)).expect(201);
  const index = (await f.db.collection('responses').listIndexes().toArray())
    .find((i) => i.name === 'responses_single_response_unique');
  assert.equal(index.unique, true);
  assert.deepEqual(index.partialFilterExpression, { singleResponseKey: { $type: 'string' } });
});

test('invalid answers, paths, object keys and all type constraints never create responses', async (t) => {
  const f = await setup(t);
  const survey = await f.survey();
  const normal = f.answers(survey);
  const invalid = [
    undefined, {}, [...normal, normal[0]], [{ questionId: randomUUID(), value: 'bad' }],
    normal.slice(1),
    normal.map((a, i) => i === 0 ? { ...a, value: 'unknown' } : a),
    normal.map((a, i) => i === 1 ? { ...a, value: [a.value[0], a.value[0]] } : a),
    normal.map((a, i) => i === 1 ? { ...a, value: ['unknown'] } : a),
    normal.map((a, i) => i === 2 ? { ...a, value: 'a' } : a),
    normal.map((a, i) => i === 2 ? { ...a, value: 'a'.repeat(21) } : a),
    ...['0', -1, 11, 0.5, Number.MAX_SAFE_INTEGER + 1].map((value) =>
      normal.map((a, i) => i === 3 ? { ...a, value } : a)),
    normal.map((a, i) => i === 0 ? { ...a, path: [] } : a),
  ];
  for (const answers of invalid) {
    const result = await f.submit(survey, answers).expect(422);
    assert.ok(result.body.error.details.field);
  }
  await f.submit(survey, normal.map((a, i) =>
    i === 0 ? { ...a, value: { $ne: null } } : a)).expect(400);
  await f.owner.agent.post(`/api/public/surveys/${survey._id}/responses?extra=1`)
    .set('X-CSRF-Token', f.owner.token).send({ answers: normal }).expect(400);
  assert.equal(await f.db.collection('responses').countDocuments(), 0);
});

test('single/multiple/number jumps replay server paths, allow END and reject hidden required answers', async (t) => {
  const f = await setup(t);
  for (const type of ['single', 'multiple', 'number']) {
    const input = type === 'number'
      ? { title: 'Source', type, required: true }
      : { title: 'Source', type, required: true, options: [{ label: 'Jump' }, { label: 'Continue' }] };
    const q1 = normalizeQuestion(input, { order: 1 });
    const q2 = normalizeQuestion({ title: 'Skipped required', type: 'text', required: true }, { order: 2 });
    const value = type === 'number' ? 0 : q1.options[0].id;
    const survey = await f.survey({
      questions: [q1, q2],
      jumpRules: [{ id: randomUUID(), sourceQuestionId: q1.id,
        operator: type === 'multiple' ? 'contains' : 'equals',
        value, targetQuestionId: 'END', priority: 0 }],
    });
    const answer = { questionId: q1.id, value: type === 'multiple' ? [value] : value };
    await f.submit(survey, [answer]).expect(201);
    const stored = await f.db.collection('responses').findOne({ surveyId: survey._id });
    assert.deepEqual(stored.path, [q1.id]);
    await f.submit(survey, [answer, { questionId: q2.id, value: 'hidden' }]).expect(422);
  }
});

test('closed, expired, draft, missing and malformed surveys cannot accept submissions', async (t) => {
  const f = await setup(t);
  for (const overrides of [
    { status: 'closed' }, { deadline: new Date(0) }, { deadline: new Date(Date.now() - 1) },
  ]) {
    const survey = await f.survey(overrides);
    const result = await f.submit(survey, f.answers(survey)).expect(410);
    assert.equal(result.body.error.code, 'SURVEY_UNAVAILABLE');
  }
  const draft = await f.survey({ status: 'draft' });
  await f.submit(draft, f.answers(draft)).expect(404);
  await f.submit({ _id: new ObjectId() }, []).expect(404);
  await f.submit({ _id: 'bad' }, []).expect(400);
  assert.equal(await f.db.collection('responses').countDocuments(), 0);
});

test('final real database read rejects close/deadline changes after initial validation', async (t) => {
  const f = await setup(t);
  for (const update of [{ status: 'closed' }, { deadline: new Date(0) }]) {
    const survey = await f.survey();
    const surveys = f.db.collection('surveys');
    const findOne = surveys.findOne.bind(surveys);
    let reads = 0;
    t.mock.method(surveys, 'findOne', async (...args) => {
      const result = await findOne(...args);
      if (++reads === 1) {
        await surveys.updateOne({ _id: survey._id }, { $set: update });
      }
      return result;
    });
    const collection = f.db.collection.bind(f.db);
    t.mock.method(f.db, 'collection', (name, ...args) =>
      name === 'surveys' ? surveys : collection(name, ...args));
    try {
      await assert.rejects(
        submitResponse(f.db, String(survey._id), { _id: f.owner.id },
          { answers: f.answers(survey) }),
        { status: 410, code: 'SURVEY_UNAVAILABLE' },
      );
      assert.equal(reads, 2);
      assert.equal(await f.db.collection('responses').countDocuments({ surveyId: survey._id }), 0);
    } finally {
      t.mock.restoreAll();
    }
  }
});

test('aggregate totals distinguish repeated/anonymous submissions, visited/answered, fraction ratios and numeric summaries', async (t) => {
  const f = await setup(t);
  const survey = await f.survey({ allowAnonymous: true });
  const [s, m, tx, n] = survey.questions;
  survey.jumpRules = [{ id: randomUUID(), sourceQuestionId: s.id, operator: 'equals',
    value: s.options[1].id, targetQuestionId: 'END', priority: 0 }];
  await f.db.collection('surveys').updateOne({ _id: survey._id }, { $set: { jumpRules: survey.jumpRules } });
  await f.submit(survey, f.answers(survey, { multiple: [0, 1], number: 2 })).expect(201);
  await f.submit(survey, [{ questionId: s.id, value: s.options[1].id }]).expect(201);
  await f.submit(survey, f.answers(survey, { multiple: [1], text: 'world', number: 8 }), f.other).expect(201);
  await f.submit(survey, f.answers(survey, { multiple: [], text: ' ', number: null }), f.anon).expect(201);
  const stats = (await f.owner.agent.get(`/api/surveys/${survey._id}/statistics`).expect(200)).body.data;
  assert.equal(stats.totalResponses, 4);
  assert.equal(stats.uniqueRegisteredRespondents, 2);
  assert.equal(stats.anonymousResponses, 1);
  assert.deepEqual(stats.questions.map((q) => [q.visitedCount, q.answeredCount]),
    [[4, 4], [3, 2], [3, 2], [3, 2]]);
  assert.deepEqual(stats.questions[0].options.map((o) => [o.count, o.ratio]), [[3, 0.75], [1, 0.25], [0, 0]]);
  assert.deepEqual(stats.questions[1].options.map((o) => [o.count, o.ratio]), [[1, 0.5], [2, 1]]);
  assert.equal(stats.questions[0].ratioUnit, 'fraction');
  assert.equal(stats.questions[0].ratioDenominator, 'answeredCount');
  assert.deepEqual(stats.questions[3].numeric, { count: 2, average: 5, min: 2, max: 8 });
  assert.equal(stats.questions.some((q) => Object.hasOwn(q, 'contents')), false);
  for (const question of [m, tx, n]) {
    const item = (await f.owner.agent.get(
      `/api/surveys/${survey._id}/statistics/questions/${question.id}`).expect(200)).body.data;
    assert.equal(item.visitedCount, 3);
    assert.equal(item.answeredCount, 2);
  }
});

test('empty statistics include zero-vote options and null numeric values; owner isolation covers both endpoints', async (t) => {
  const f = await setup(t);
  const survey = await f.survey({ status: 'draft' });
  const base = `/api/surveys/${survey._id}/statistics`;
  const stats = (await f.owner.agent.get(base).expect(200)).body.data;
  assert.equal(stats.totalResponses, 0);
  assert.equal(stats.uniqueRegisteredRespondents, 0);
  assert.equal(stats.anonymousResponses, 0);
  for (const q of stats.questions) {
    assert.equal(q.visitedCount, 0);
    assert.equal(q.answeredCount, 0);
    q.options?.forEach((o) => { assert.equal(o.count, 0); assert.equal(o.ratio, 0); });
  }
  assert.deepEqual(stats.questions[3].numeric, { count: 0, average: null, min: null, max: null });
  for (const url of [base, `${base}/questions/${survey.questions[2].id}`]) {
    await request(f.app).get(url).expect(401);
    await f.other.agent.get(url).expect(404);
  }
  const contents = (await f.owner.agent.get(`${base}/questions/${survey.questions[2].id}`)
    .expect(200)).body.data.contents;
  assert.deepEqual(contents, { items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
  await f.owner.agent.get('/api/surveys/bad/statistics').expect(400);
  await f.owner.agent.get(`/api/surveys/${new ObjectId()}/statistics`).expect(404);
  await f.owner.agent.get(`${base}/questions/bad`).expect(400);
  await f.owner.agent.get(`${base}/questions/${randomUUID()}`).expect(404);
  await f.owner.agent.get(`${base}?page=1`).expect(400);
});

test('text and numeric contents page through all responses with submittedAt/_id tie-break order and bounded input', async (t) => {
  const f = await setup(t);
  const survey = await f.survey();
  for (let i = 0; i < 23; i++) {
    await f.submit(survey, f.answers(survey, { text: `text-${i}`, number: i % 11 })).expect(201);
  }
  await f.db.collection('responses').updateMany({ surveyId: survey._id },
    { $set: { submittedAt: new Date('2026-01-01T00:00:00Z') } });
  const expected = await f.db.collection('responses').find({ surveyId: survey._id })
    .sort({ submittedAt: -1, _id: -1 }).toArray();
  for (const question of survey.questions.slice(2)) {
    const base = `/api/surveys/${survey._id}/statistics/questions/${question.id}`;
    const first = (await f.owner.agent.get(base).expect(200)).body.data.contents;
    assert.equal(first.items.length, 20);
    assert.equal(first.pageSize, 20);
    assert.equal(first.totalItems, 23);
    assert.equal(first.totalPages, 2);
    const second = (await f.owner.agent.get(`${base}?page=2`).expect(200)).body.data.contents;
    assert.equal(second.items.length, 3);
    assert.deepEqual([...first.items, ...second.items].map((i) => i.responseId),
      expected.map((r) => String(r._id)));
    assert.deepEqual([...first.items, ...second.items].map((i) => i.value),
      expected.map((r) => r.answers.find((a) => a.questionId === question.id).value));
    assert.deepEqual(Object.keys(first.items[0]).sort(), ['responseId', 'submittedAt', 'value'].sort());
    assert.equal((await f.owner.agent.get(`${base}?page=3`).expect(200)).body.data.contents.items.length, 0);
    assert.equal((await f.owner.agent.get(`${base}?pageSize=100`).expect(200)).body.data.contents.items.length, 23);
    for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=9007199254740991',
      'pageSize=101', 'pageSize=0', 'pageSize=abc', 'page=1&page=2', 'page[$ne]=1', 'extra=1']) {
      await f.owner.agent.get(`${base}?${query}`).expect(400);
    }
  }
});
