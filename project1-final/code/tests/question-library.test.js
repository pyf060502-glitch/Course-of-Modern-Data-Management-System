import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { normalizeQuestion } from '../src/validators/questions.js';
import { createTestDatabase } from './helpers/database.js';
import { questionContentKey } from '../src/validators/question-content.js';
import { ensureIndexes } from '../src/db/indexes.js';

const base = '/api/question-library';
const definitions = [
  { title: '年龄', type: 'number', required: true, validation: { min: 0, max: 150, integer: true } },
  { title: '职业', type: 'single', required: true, options: [{ label: '学生' }, { label: '其他' }] },
  { title: '兴趣', type: 'multiple', options: [{ label: '阅读' }, { label: '运动' }], validation: { exactSelections: 1 } },
  { title: '建议', type: 'text', validation: { minLength: 2, maxLength: 200 } },
];

async function setup(t) {
  const f = await createTestDatabase();
  const app = createApp(f);
  t.after(async () => {
    try { await app.locals.sessionStore.close(); } finally { await f.cleanup(); }
  });
  await app.locals.sessionStoreReady;
  const users = [];
  for (const username of ['library_owner', 'library_other']) {
    const agent = request.agent(app);
    const token = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
    await agent.post('/api/auth/register').set('X-CSRF-Token', token)
      .send({ username, password: 'password123' }).expect(201);
    const login = (await agent.post('/api/auth/login').set('X-CSRF-Token', token)
      .send({ username, password: 'password123' }).expect(200)).body.data;
    users.push({ agent, token: login.csrfToken });
  }
  const [owner, other] = users;
  const write = (method, url, body, user = owner) => user.agent[method](url)
    .set('X-CSRF-Token', user.token).send(body);
  const create = async (question = definitions[0]) =>
    (await write('post', base, { question }).expect(201)).body.data;
  const survey = async () => (await write('post', '/api/surveys', {
    title: '复用测试', allowAnonymous: true,
  }).expect(201)).body.data;
  const getSurvey = async (id) => (await owner.agent.get(`/api/surveys/${id}`).expect(200)).body.data;
  const use = (surveyId, id, user = owner) => write('post', `/api/surveys/${surveyId}/questions/from-library`,
    { libraryQuestionId: id }, user);
  return { ...f, app, owner, other, write, create, survey, getSurvey, use };
}

test('library CRUD preserves all four question types, validation and stable edit IDs', async (t) => {
  const f = await setup(t);
  for (const question of definitions) {
    const record = await f.create(question);
    assert.equal(record.question.title, question.title);
    assert.deepEqual(record.question.validation, question.validation ?? {});
    const stored = await f.db.collection('questionLibrary').findOne({ _id: new ObjectId(record.id) });
    assert.ok(stored.ownerId instanceof ObjectId);
    assert.ok(stored.createdAt instanceof Date);
    const updated = (await f.write('patch', `${base}/${record.id}`, {
      question: { title: `${question.title}（常用）` },
    }).expect(200)).body.data;
    assert.equal(updated.question.id, record.question.id);
    assert.deepEqual(updated.question.options, record.question.options);
    assert.deepEqual(updated.question.validation, record.question.validation);
    await f.write('delete', `${base}/${record.id}`).expect(200);
    await f.owner.agent.get(`${base}/${record.id}`).expect(404);
  }
  assert.equal(await f.db.collection('questionLibrary').countDocuments(), 0);
});

test('library rejects unauthenticated, missing CSRF, unsafe and invalid definitions without writes', async (t) => {
  const f = await setup(t);
  await request(f.app).get(base).expect(401);
  await f.owner.agent.post(base).send({ question: definitions[0] }).expect(403);
  const anon = request.agent(f.app);
  const token = (await anon.get('/api/auth/csrf')).body.data.csrfToken;
  await anon.post(base).set('X-CSRF-Token', token).send({ question: definitions[0] }).expect(401);
  for (const body of [
    {}, { question: definitions[0], ownerId: new ObjectId().toHexString() },
    { question: { ...definitions[0], type: 'unknown' } },
    { question: { ...definitions[0], validation: { min: 10, max: 0 } } },
    { question: { title: '选项', type: 'single', options: [] } },
    { question: { ...definitions[0], $set: {} } },
    { question: { ...definitions[0], id: 'forged' } },
  ]) await f.write('post', base, body).expect(400);
  await f.owner.agent.get(`${base}/bad`).expect(400);
  await f.owner.agent.get(`${base}?page=0`).expect(400);
  await f.owner.agent.get(`${base}?pageSize=101`).expect(400);
  await f.owner.agent.get(`${base}?ownerId=forged`).expect(400);
  assert.equal(await f.db.collection('questionLibrary').countDocuments(), 0);
});

test('all library and reuse endpoints isolate both the source and destination owners', async (t) => {
  const f = await setup(t);
  const record = await f.create();
  const survey = await f.survey();
  const q = (await f.use(survey.id, record.id).expect(201)).body.data.question;
  assert.equal((await f.other.agent.get(base).expect(200)).body.data.total, 0);
  await f.other.agent.get(`${base}/${record.id}`).expect(404);
  await f.write('patch', `${base}/${record.id}`, { question: { title: '篡改' } }, f.other).expect(404);
  await f.write('delete', `${base}/${record.id}`, undefined, f.other).expect(404);
  await f.use(survey.id, record.id, f.other).expect(404);
  const ownRecord = (await f.write('post', base, { question: definitions[0] }, f.other).expect(201)).body.data;
  await f.use(survey.id, ownRecord.id, f.other).expect(404);
  await f.use(survey.id, ownRecord.id).expect(404);
  await f.write('post', `/api/surveys/${survey.id}/questions/${q.id}/save-to-library`, undefined, f.other).expect(404);
  await f.write('post', `/api/surveys/${survey.id}/questions/${q.id}/save-to-library`, { ownerId: 'forged' }).expect(400);
  assert.equal((await f.getSurvey(survey.id)).questions.length, 1);
});

test('one saved definition is independently reusable across surveys and within the same survey', async (t) => {
  const f = await setup(t);
  const source = await f.create(definitions[1]);
  const a = await f.survey();
  const b = await f.survey();
  const imported = [];
  for (const target of [a, a, b]) imported.push((await f.use(target.id, source.id).expect(201)).body.data.question);
  assert.equal(new Set([source.question.id, ...imported.map((q) => q.id)]).size, 4);
  assert.equal(new Set([source.question, ...imported].flatMap((q) => q.options.map((o) => o.id))).size, 8);
  assert.deepEqual((await f.getSurvey(a.id)).questions.map((q) => q.order), [1, 2]);
  await f.write('patch', `${base}/${source.id}`, { question: { title: '新模板标题' } }).expect(200);
  assert.equal((await f.getSurvey(a.id)).questions[0].title, '职业');
  await f.write('patch', `/api/surveys/${a.id}/questions/${imported[0].id}`, { question: { title: '本卷职业' } }).expect(200);
  assert.equal((await f.getSurvey(b.id)).questions[0].title, '职业');
  assert.equal((await f.owner.agent.get(`${base}/${source.id}`)).body.data.question.title, '新模板标题');
  await f.write('delete', `${base}/${source.id}`).expect(200);
  assert.equal((await f.getSurvey(b.id)).questions[0].title, '职业');
  await f.use(b.id, source.id).expect(404);
  await f.write('delete', `/api/surveys/${a.id}`).expect(200);
  assert.equal((await f.getSurvey(b.id)).questions.length, 1);
});

test('save an existing published question without rules; imported questions still submit and aggregate', async (t) => {
  const f = await setup(t);
  const a = await f.survey();
  for (const question of definitions) await f.write('post', `/api/surveys/${a.id}/questions`, { question }).expect(201);
  const original = await f.getSurvey(a.id);
  await f.write('put', `/api/surveys/${a.id}/jump-rules`, { rules: [{
    sourceQuestionId: original.questions[0].id, operator: 'greater_than', value: 100,
    targetQuestionId: 'END', priority: 0,
  }] }).expect(200);
  await f.write('post', `/api/surveys/${a.id}/publish`).expect(200);
  const b = await f.survey();
  const sources = [];
  for (const question of original.questions) {
    const record = (await f.write('post', `/api/surveys/${a.id}/questions/${question.id}/save-to-library`).expect(201)).body.data;
    sources.push(record);
    assert.equal(record.question.order, 1);
    assert.notEqual(record.question.id, question.id);
    assert.equal(record.question.jumpRules, undefined);
    await f.use(b.id, record.id).expect(201);
  }
  const target = await f.getSurvey(b.id);
  assert.deepEqual(target.jumpRules, []);
  assert.deepEqual(target.questions.map((q) => q.validation), original.questions.map((q) => q.validation));
  await f.write('post', `/api/surveys/${b.id}/publish`).expect(200);
  const [number, single, multiple, text] = target.questions;
  await f.write('post', `/api/public/surveys/${b.id}/responses`, { answers: [
    { questionId: number.id, value: 20 }, { questionId: single.id, value: single.options[0].id },
    { questionId: multiple.id, value: [multiple.options[1].id] }, { questionId: text.id, value: '很好' },
  ] }).expect(201);
  const stats = (await f.owner.agent.get(`/api/surveys/${b.id}/statistics`).expect(200)).body.data;
  assert.equal(stats.totalResponses, 1);
  assert.equal(stats.questions[0].numeric.average, 20);
  assert.equal(stats.questions[1].options[0].count, 1);
  for (const source of sources) await f.write('delete', `${base}/${source.id}`).expect(200);
  assert.equal((await f.owner.agent.get(`/api/surveys/${b.id}/statistics`)).body.data.totalResponses, 1);
});

test('import respects draft locks, maximum size, body whitelist and missing IDs', async (t) => {
  const f = await setup(t);
  const source = await f.create();
  const survey = await f.survey();
  const url = `/api/surveys/${survey.id}/questions/from-library`;
  for (const body of [{}, { libraryQuestionId: 'bad' }, { libraryQuestionId: source.id, question: definitions[0] }]) {
    await f.write('post', url, body).expect(400);
  }
  await f.use(survey.id, new ObjectId().toHexString()).expect(404);
  await f.owner.agent.post(url).send({ libraryQuestionId: source.id }).expect(403);
  await f.use(survey.id, source.id).expect(201);
  await f.write('post', `/api/surveys/${survey.id}/publish`).expect(200);
  await f.use(survey.id, source.id).expect(409);
  await f.write('post', `/api/surveys/${survey.id}/close`).expect(200);
  await f.use(survey.id, source.id).expect(409);
  const full = await f.survey();
  await f.db.collection('surveys').updateOne({ _id: new ObjectId(full.id) }, { $set: {
    questions: Array.from({ length: 99 }, (_, index) => normalizeQuestion(definitions[0], { order: index + 1 })),
  } });
  await f.use(full.id, source.id).expect(201);
  await f.use(full.id, source.id).expect(400);
  assert.equal((await f.getSurvey(full.id)).questions.length, 100);
});

test('library pagination remains stable for tied timestamps and never mixes owners', async (t) => {
  const f = await setup(t);
  const source = await f.create();
  const original = await f.db.collection('questionLibrary').findOne({ _id: new ObjectId(source.id) });
  await f.db.collection('questionLibrary').insertMany(Array.from({ length: 22 }, (_, i) => {
    const question = normalizeQuestion({ ...definitions[0], title: `年龄${i}` });
    return { ...original, _id: new ObjectId(), question, contentKey: questionContentKey(question) };
  }));
  const first = (await f.owner.agent.get(`${base}?page=1&pageSize=20`).expect(200)).body.data;
  const second = (await f.owner.agent.get(`${base}?page=2&pageSize=20`).expect(200)).body.data;
  assert.equal(first.total, 23);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 3);
  assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 23);
  assert.deepEqual((await f.owner.agent.get(`${base}?page=1&pageSize=20`)).body.data, first);
  assert.equal((await f.other.agent.get(base)).body.data.total, 0);
  assert.ok((await f.db.collection('questionLibrary').indexes()).some((index) => index.name === 'question_library_owner_created'));
});

test('concurrent imports never lose successful additions or produce duplicate orders', async (t) => {
  const f = await setup(t);
  const source = await f.create();
  const survey = await f.survey();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.use(survey.id, source.id)));
  assert.ok(results.every((r) => [201, 409].includes(r.status)));
  const count = results.filter((r) => r.status === 201).length;
  assert.ok(count >= 1);
  const saved = await f.getSurvey(survey.id);
  assert.equal(saved.questions.length, count);
  assert.equal(new Set(saved.questions.map((q) => q.id)).size, count);
  assert.deepEqual(saved.questions.map((q) => q.order), Array.from({ length: count }, (_, i) => i + 1));
  await f.use(survey.id, source.id).expect(201);
  assert.equal((await f.getSurvey(survey.id)).questions.length, count + 1);
});

test('default app serves the library and shared form before page controllers', async (t) => {
  const f = await setup(t);
  const page = await request(f.app).get('/question-library').expect(200);
  assert.ok(page.text.indexOf('/js/question-fields.js') < page.text.indexOf('/js/question-library.js'));
  const editor = await request(f.app).get(`/surveys/${new ObjectId()}/edit`).expect(200);
  assert.ok(editor.text.indexOf('/js/question-fields.js') < editor.text.indexOf('/js/editor.js'));
  assert.match(editor.text, /import-library-question/);
  await request(f.app).get('/js/question-fields.js').expect(200);
  await request(f.app).get('/js/question-library.js').expect(200);
});

test('identical definitions save successfully once across all four types and survey save entry points', async (t) => {
  const f = await setup(t);
  const survey = await f.survey();
  for (const definition of definitions) {
    const first = await f.create(definition);
    const stored = await f.db.collection('questionLibrary').findOne({ _id: new ObjectId(first.id) });
    const again = await f.create(definition);
    assert.equal(again.id, first.id);
    assert.deepEqual(again.question, first.question);
    assert.equal(again.createdAt, first.createdAt);
    assert.equal(again.updatedAt, first.updatedAt);
    assert.equal(again.contentKey, undefined);
    const q = (await f.use(survey.id, first.id).expect(201)).body.data.question;
    const url = `/api/surveys/${survey.id}/questions/${q.id}/save-to-library`;
    for (let i = 0; i < 2; i++) {
      const result = (await f.write('post', url).expect(201)).body.data;
      assert.equal(result.id, first.id);
    }
    assert.deepEqual(await f.db.collection('questionLibrary').findOne({ _id: stored._id }), stored);
  }
  assert.equal((await f.owner.agent.get(base)).body.data.total, 4);
  assert.equal(await f.db.collection('questionLibrary').countDocuments(), 4);
});

test('simultaneous identical saves return the same template and unique index rejects duplicate writes', async (t) => {
  const f = await setup(t);
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    f.write('post', base, { question: definitions[1] }).expect(201)));
  assert.equal(new Set(results.map((result) => result.body.data.id)).size, 1);
  assert.equal(await f.db.collection('questionLibrary').countDocuments(), 1);
  const record = await f.db.collection('questionLibrary').findOne({});
  await assert.rejects(f.db.collection('questionLibrary').insertOne({ ...record, _id: new ObjectId() }), { code: 11000 });
});

test('content identity ignores UUIDs and explicit defaults but preserves meaningful differences and owners', async (t) => {
  const f = await setup(t);
  const first = await f.create({ title: '同题', type: 'number' });
  const defaults = await f.create({ title: ' 同题 ', type: 'number', required: false, validation: { integer: false } });
  assert.equal(defaults.id, first.id);
  for (const question of [
    { title: '其他', type: 'number' }, { title: '同题', type: 'text' },
    { title: '同题', type: 'number', required: true },
    { title: '同题', type: 'number', validation: { integer: true } },
    { title: '同题', type: 'number', validation: { min: 0 } },
  ]) assert.notEqual((await f.create(question)).id, first.id);
  const choice = await f.create(definitions[1]);
  const reversed = await f.create({ ...definitions[1], options: [...definitions[1].options].reverse() });
  assert.notEqual(reversed.id, choice.id);
  const relabeled = await f.create({ ...definitions[1], options: [{ label: '学生' }, { label: '工作' }] });
  assert.notEqual(relabeled.id, choice.id);
  const other = (await f.write('post', base, { question: { title: '同题', type: 'number' } }, f.other).expect(201)).body.data;
  assert.notEqual(other.id, first.id);
  assert.equal((await f.other.agent.get(base)).body.data.total, 1);
});

test('editing into identical content merges templates successfully without altering imported snapshots', async (t) => {
  const f = await setup(t);
  const a = await f.create();
  const b = await f.create({ ...definitions[0], title: '另一题' });
  const survey = await f.survey();
  await f.use(survey.id, b.id).expect(201);
  const before = await f.getSurvey(survey.id);
  const merged = (await f.write('patch', `${base}/${b.id}`, { question: { title: a.question.title } }).expect(200)).body.data;
  assert.equal(merged.id, a.id);
  assert.deepEqual(merged.question, a.question);
  assert.equal((await f.owner.agent.get(base)).body.data.total, 1);
  await f.owner.agent.get(`${base}/${b.id}`).expect(404);
  assert.deepEqual(await f.getSurvey(survey.id), before);
  assert.equal((await f.create()).id, a.id);
  await f.write('patch', `${base}/${a.id}`, { question: { title: '新内容' } }).expect(200);
  assert.notEqual((await f.create()).id, a.id);
  assert.equal((await f.owner.agent.get(base)).body.data.total, 2);
});

test('startup migrates legacy duplicates per owner, preserves retained IDs and snapshots, and is idempotent', async (t) => {
  const f = await setup(t);
  const first = await f.create(definitions[1]);
  const survey = await f.survey();
  await f.use(survey.id, first.id).expect(201);
  const beforeSurvey = await f.getSurvey(survey.id);
  const collection = f.db.collection('questionLibrary');
  const record = await collection.findOne({ _id: new ObjectId(first.id) });
  await collection.dropIndex('question_library_owner_content_unique');
  await collection.updateOne({ _id: record._id }, { $unset: { contentKey: '' } });
  const otherUser = await f.db.collection('users').findOne({ username: 'library_other' });
  await collection.insertMany([
    { ...record, _id: new ObjectId('ffffffffffffffffffffff01'), contentKey: undefined, question: normalizeQuestion(definitions[1]) },
    { ...record, _id: new ObjectId('ffffffffffffffffffffff02'), contentKey: undefined, question: normalizeQuestion(definitions[1]) },
    { ...record, _id: new ObjectId(), ownerId: otherUser._id, contentKey: undefined },
    { ...record, _id: new ObjectId(), contentKey: undefined, question: normalizeQuestion({ ...definitions[1], required: false }) },
  ]);
  await ensureIndexes(f.db);
  assert.equal(await collection.countDocuments(), 3);
  const retained = await collection.findOne({ _id: record._id });
  assert.deepEqual(retained, record);
  assert.deepEqual(await f.getSurvey(survey.id), beforeSurvey);
  const snapshot = await collection.find({}).sort({ _id: 1 }).toArray();
  await ensureIndexes(f.db);
  assert.deepEqual(await collection.find({}).sort({ _id: 1 }).toArray(), snapshot);
  assert.equal((await f.create(definitions[1])).id, first.id);
  assert.equal((await f.owner.agent.get(base)).body.data.total, 2);
  assert.equal((await f.other.agent.get(base)).body.data.total, 1);
});

test('four-type library sharing gives recipient independent reusable definitions and keeps sender records', async (t) => {
  const f = await setup(t);
  for (const definition of definitions) {
    const source = await f.create(definition);
    const before = await f.db.collection('questionLibrary').findOne({ _id: new ObjectId(source.id) });
    const beforeCount = (await f.other.agent.get(base)).body.data.total;
    const shared = (await f.write('post', `${base}/${source.id}/share`, { username: ' LIBRARY_OTHER ' }).expect(200)).body.data;
    assert.deepEqual(shared, { shared: true, recipient: { username: 'library_other' } });
    assert.equal((await f.other.agent.get(base)).body.data.total, beforeCount);
    const notice = (await f.other.agent.get('/api/notifications')).body.data.items.find((item) => item.question.title === definition.title);
    assert.equal(notice.status, 'pending');
    await f.write('post', `/api/notifications/${notice.id}/accept`, undefined, f.other).expect(200);
    const received = (await f.other.agent.get(base)).body.data.items.find((record) => record.question.title === definition.title);
    assert.ok(received);
    assert.notEqual(received.id, source.id);
    assert.notEqual(received.question.id, source.question.id);
    assert.deepEqual(received.question.validation, source.question.validation);
    assert.deepEqual(received.question.options.map((option) => option.label), source.question.options.map((option) => option.label));
    for (let i = 0; i < source.question.options.length; i++) {
      assert.notEqual(received.question.options[i].id, source.question.options[i].id);
    }
    assert.deepEqual(await f.db.collection('questionLibrary').findOne({ _id: before._id }), before);
    await f.write('patch', `${base}/${received.id}`, { question: { title: `对方的${definition.title}` } }, f.other).expect(200);
    assert.equal((await f.owner.agent.get(`${base}/${source.id}`)).body.data.question.title, definition.title);
    await f.write('delete', `${base}/${source.id}`).expect(200);
    assert.equal((await f.other.agent.get(`${base}/${received.id}`)).body.data.question.title, `对方的${definition.title}`);
  }
  assert.equal((await f.other.agent.get(base)).body.data.total, 4);
});

test('survey sharing works after publish/close; recipient can import, submit and view own statistics', async (t) => {
  const f = await setup(t);
  const source = await f.survey();
  for (const question of definitions) await f.write('post', `/api/surveys/${source.id}/questions`, { question }).expect(201);
  const saved = await f.getSurvey(source.id);
  await f.write('put', `/api/surveys/${source.id}/jump-rules`, { rules: [{
    sourceQuestionId: saved.questions[0].id, operator: 'greater_than', value: 100, targetQuestionId: 'END', priority: 0,
  }] }).expect(200);
  await f.write('post', `/api/surveys/${source.id}/publish`).expect(200);
  for (const question of saved.questions) {
    await f.write('post', `/api/surveys/${source.id}/questions/${question.id}/share`, { username: 'library_other' }).expect(200);
  }
  await f.write('post', `/api/surveys/${source.id}/close`).expect(200);
  await f.write('post', `/api/surveys/${source.id}/questions/${saved.questions[0].id}/share`, { username: 'library_other' }).expect(200);
  assert.equal((await f.owner.agent.get(base)).body.data.total, 0);
  assert.equal((await f.other.agent.get(base)).body.data.total, 0);
  const notices = (await f.other.agent.get('/api/notifications')).body.data.items;
  assert.equal(notices.length, 4);
  for (const notice of notices) await f.write('post', `/api/notifications/${notice.id}/accept`, undefined, f.other).expect(200);
  const received = (await f.other.agent.get(base)).body.data.items;
  assert.equal(received.length, 4);
  const target = (await f.write('post', '/api/surveys', { title: '接收者问卷' }, f.other).expect(201)).body.data;
  for (const definition of definitions) {
    await f.use(target.id, received.find((record) => record.question.title === definition.title).id, f.other).expect(201);
  }
  const imported = (await f.other.agent.get(`/api/surveys/${target.id}`)).body.data;
  assert.deepEqual(imported.jumpRules, []);
  await f.write('post', `/api/surveys/${target.id}/publish`, undefined, f.other).expect(200);
  const [number, single, multiple, text] = imported.questions;
  await f.write('post', `/api/public/surveys/${target.id}/responses`, { answers: [
    { questionId: number.id, value: 20 }, { questionId: single.id, value: single.options[0].id },
    { questionId: multiple.id, value: [multiple.options[0].id] }, { questionId: text.id, value: '收到题目' },
  ] }, f.other).expect(201);
  const stats = (await f.other.agent.get(`/api/surveys/${target.id}/statistics`).expect(200)).body.data;
  assert.equal(stats.totalResponses, 1);
  assert.equal(stats.questions[0].numeric.average, 20);
  assert.deepEqual((await f.getSurvey(source.id)).questions, saved.questions);
});

test('repeat and concurrent shares reuse recipient existing content without overwriting edits or source', async (t) => {
  const f = await setup(t);
  const source = await f.create();
  const existing = (await f.write('post', base, { question: definitions[0] }, f.other).expect(201)).body.data;
  const before = await f.db.collection('questionLibrary').findOne({ _id: new ObjectId(existing.id) });
  await Promise.all(Array.from({ length: 6 }, () => f.write('post', `${base}/${source.id}/share`, { username: 'library_other' }).expect(200)));
  assert.equal((await f.other.agent.get(base)).body.data.total, 1);
  assert.deepEqual(await f.db.collection('questionLibrary').findOne({ _id: before._id }), before);
  const notice = (await f.other.agent.get('/api/notifications')).body.data.items[0];
  assert.equal((await f.other.agent.get('/api/notifications')).body.data.total, 1);
  await f.write('post', `/api/notifications/${notice.id}/accept`, undefined, f.other).expect(200);
  assert.deepEqual(await f.db.collection('questionLibrary').findOne({ _id: before._id }), before);
  await f.write('patch', `${base}/${existing.id}`, { question: { title: '已由对方修改' } }, f.other).expect(200);
  await f.write('post', `${base}/${source.id}/share`, { username: 'library_other' }).expect(200);
  assert.equal((await f.other.agent.get(base)).body.data.total, 1);
  await f.write('delete', `/api/notifications/${notice.id}`, undefined, f.other).expect(200);
  await f.write('post', `${base}/${source.id}/share`, { username: 'library_other' }).expect(200);
  const newNotice = (await f.other.agent.get('/api/notifications')).body.data.items[0];
  await f.write('post', `/api/notifications/${newNotice.id}/accept`, undefined, f.other).expect(200);
  assert.equal((await f.other.agent.get(base)).body.data.total, 2);
  assert.equal((await f.other.agent.get(`${base}/${existing.id}`)).body.data.question.title, '已由对方修改');
  assert.equal((await f.owner.agent.get(`${base}/${source.id}`)).body.data.question.title, definitions[0].title);
});

test('sharing requires sender auth, CSRF and ownership of the exact library or survey question', async (t) => {
  const f = await setup(t);
  const source = await f.create();
  const survey = await f.survey();
  const question = (await f.use(survey.id, source.id).expect(201)).body.data.question;
  const urls = [`${base}/${source.id}/share`, `/api/surveys/${survey.id}/questions/${question.id}/share`];
  const anonymous = request.agent(f.app);
  const csrf = (await anonymous.get('/api/auth/csrf')).body.data.csrfToken;
  for (const url of urls) {
    await f.owner.agent.post(url).send({ username: 'library_other' }).expect(403);
    await anonymous.post(url).set('X-CSRF-Token', csrf).send({ username: 'library_other' }).expect(401);
    await f.write('post', url, { username: 'library_owner' }, f.other).expect(404);
  }
  await f.write('post', `${base}/bad/share`, { username: 'library_other' }).expect(400);
  await f.write('post', `/api/surveys/${survey.id}/questions/bad/share`, { username: 'library_other' }).expect(400);
  await f.write('post', `/api/surveys/${survey.id}/questions/${normalizeQuestion(definitions[0]).id}/share`, { username: 'library_other' }).expect(404);
  await f.other.agent.get(`${base}/${source.id}`).expect(404);
  await f.other.agent.get(`/api/surveys/${survey.id}`).expect(404);
  assert.equal((await f.other.agent.get(base)).body.data.total, 0);
  assert.equal(await f.db.collection('notifications').countDocuments(), 0);
});

test('invalid recipients and forged share payloads fail without granting access or creating records', async (t) => {
  const f = await setup(t);
  const source = await f.create();
  const survey = await f.survey();
  const question = (await f.use(survey.id, source.id).expect(201)).body.data.question;
  for (const url of [`${base}/${source.id}/share`, `/api/surveys/${survey.id}/questions/${question.id}/share`]) {
    for (const body of [{}, { username: null }, { username: 'x' }, { username: 'bad user' },
      { username: 'library_other', ownerId: new ObjectId().toHexString() },
      { username: 'library_other', question: definitions[1] }, { username: { $ne: null } }]) {
      await f.write('post', url, body).expect(400);
    }
    const missing = await f.write('post', url, { username: 'not_registered' }).expect(404);
    assert.equal(missing.body.error.code, 'RECIPIENT_NOT_FOUND');
    const self = await f.write('post', url, { username: 'LIBRARY_OWNER' }).expect(400);
    assert.equal(self.body.error.code, 'INVALID_RECIPIENT');
    await f.write('post', `${url}?username=library_owner`, { username: 'library_other' }).expect(400);
  }
  assert.equal(await f.db.collection('questionLibrary').countDocuments(), 1);
  assert.equal((await f.other.agent.get(base)).body.data.total, 0);
});
