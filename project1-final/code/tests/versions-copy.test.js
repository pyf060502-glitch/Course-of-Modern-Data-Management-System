import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createTestDatabase } from './helpers/database.js';

async function setup(t) {
  const f = await createTestDatabase();
  const app = createApp(f);
  t.after(async () => { try { await app.locals.sessionStore.close(); } finally { await f.cleanup(); } });
  await app.locals.sessionStoreReady;
  const users = [];
  for (const username of ['version_owner', 'version_other']) {
    const agent = request.agent(app);
    const csrf = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
    await agent.post('/api/auth/register').set('X-CSRF-Token', csrf).send({ username, password: 'password123' }).expect(201);
    const login = (await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username, password: 'password123' }).expect(200)).body.data;
    users.push({ agent, token: login.csrfToken });
  }
  const [owner, other] = users;
  const write = (method, path, body, user = owner) => user.agent[method](path).set('X-CSRF-Token', user.token).send(body);
  const get = async (path, user = owner) => (await user.agent.get(path).expect(200)).body.data;
  const survey = async (title = '问卷') => (await write('post', '/api/surveys', { title, allowAnonymous: true }).expect(201)).body.data;
  const add = async (id, question) => (await write('post', `/api/surveys/${id}/questions`, { question }).expect(201)).body.data.question;
  const library = async (title = '年龄') => (await write('post', '/api/question-library', { question: {
    title, type: 'number', required: true, validation: { min: 0, max: 120, integer: true },
  } }).expect(201)).body.data;
  return { ...f, app, owner, other, write, get, survey, add, library };
}

test('cross-survey number statistics weight every answer, deduplicate people, paginate contents and protect owners', async (t) => {
  const f = await setup(t);
  const r = await f.library();
  const path = `/api/question-library/${r.id}/statistics`;
  const empty = await f.get(path);
  assert.equal(empty.totalResponses, 0); assert.deepEqual(empty.groups, []);
  const a = await f.survey('A'), b = await f.survey('B');
  const imported = async (s) => (await f.write('post', `/api/surveys/${s.id}/questions/from-library`, { libraryQuestionId: r.id }).expect(201)).body.data.question;
  const q1 = await imported(a), q2 = await imported(a), q3 = await imported(b);
  for (const s of [a, b]) await f.write('post', `/api/surveys/${s.id}/publish`).expect(200);
  for (const values of [[10, 20], [30, 40]]) await f.write('post', `/api/public/surveys/${a.id}/responses`, {
    answers: [{ questionId: q1.id, value: values[0] }, { questionId: q2.id, value: values[1] }],
  }).expect(201);
  // Other logged-in person, same question family. Owner scope concerns the survey, not the respondent.
  await f.write('post', `/api/public/surveys/${b.id}/responses`, { answers: [{ questionId: q3.id, value: 50 }] }, f.other).expect(201);
  const data = await f.get(`${path}?pageSize=2`);
  assert.equal(data.surveyCount, 2); assert.equal(data.questionCount, 3);
  assert.equal(data.totalResponses, 3); assert.equal(data.uniqueRegisteredRespondents, 2);
  assert.equal(data.visitedCount, 5); assert.equal(data.answeredCount, 5);
  assert.deepEqual(data.groups[0].numeric, { count: 5, average: 30, min: 10, max: 50 });
  assert.equal(data.groups[0].contents.totalItems, 5); assert.equal(data.groups[0].contents.items.length, 2);
  const pages = await Promise.all([2, 3].map((page) => f.get(`${path}?page=${page}&pageSize=2&group=${data.selectedGroup}`)));
  const items = [...data.groups[0].contents.items, ...pages.flatMap((p) => p.groups[0].contents.items)];
  assert.deepEqual(items.map((i) => i.value).sort((a, b) => a - b), [10, 20, 30, 40, 50]);
  assert.ok(items.every((i) => i.surveyTitle && !i.respondentId));
  await f.other.agent.get(path).expect(404); await request(f.app).get(path).expect(401);
  for (const query of ['page=0', 'group=bad', 'ownerId=forged']) await f.owner.agent.get(`${path}?${query}`).expect(400);
  await f.write('delete', `/api/surveys/${b.id}`).expect(200);
  assert.equal((await f.get(path)).answeredCount, 4);
});

for (const type of ['single', 'multiple']) test(`cross-survey ${type} votes align independent option IDs, retain zero votes and split changed options`, async (t) => {
  const f = await setup(t);
  const r = (await f.write('post', '/api/question-library', { question: { title: '选择', type,
    options: [{ label: '甲' }, { label: '乙' }, { label: '零票' }], required: false } }).expect(201)).body.data;
  const path = `/api/question-library/${r.id}`;
  const surveys = [];
  for (let n = 0; n < 2; n++) {
    const s = await f.survey(`选择${n}`);
    const q = (await f.write('post', `/api/surveys/${s.id}/questions/from-library`, { libraryQuestionId: r.id }).expect(201)).body.data.question;
    surveys.push(s);
    await f.write('post', `/api/surveys/${s.id}/publish`).expect(200);
    const value = type === 'single' ? q.options[n].id : q.options.slice(0, 2).map((o) => o.id);
    await f.write('post', `/api/public/surveys/${s.id}/responses`, { answers: [{ questionId: q.id, value }] }).expect(201);
    await f.write('post', `/api/public/surveys/${s.id}/responses`, { answers: [] }).expect(201);
  }
  const merged = await f.get(`${path}/statistics`);
  assert.equal(merged.visitedCount, 4); assert.equal(merged.answeredCount, 2);
  assert.deepEqual(merged.groups[0].options.map((o) => o.count), type === 'single' ? [1, 1, 0] : [2, 2, 0]);
  assert.deepEqual(merged.groups[0].options.map((o) => o.ratio), type === 'single' ? [0.5, 0.5, 0] : [1, 1, 0]);
  const versionId = (await f.get(`${path}/history`)).items[0].id;
  const branch = (await f.write('post', `${path}/versions`, { versionId, question: { options: [{ label: '不同甲' }, { label: '乙' }] } }).expect(201)).body.data;
  const s = await f.survey('不同选项');
  await f.write('post', `/api/surveys/${s.id}/questions/from-library`, { libraryQuestionId: branch.id }).expect(201);
  const split = await f.get(`${path}/statistics`);
  assert.equal(split.groups.length, 2);
  assert.equal(split.groups.find((g) => g.answeredCount === 0).options[0].ratio, 0);
});

test('cross-survey text contents and changed-type versions stay separate and paginate with empty/anonymous responses', async (t) => {
  const f = await setup(t);
  const r = await f.library();
  const path = `/api/question-library/${r.id}`;
  const versionId = (await f.get(`${path}/history`)).items[0].id;
  const branch = (await f.write('post', `${path}/versions`, { versionId, question: { title: '文本版本', type: 'text', required: false } }).expect(201)).body.data;
  const s = await f.survey('文本问卷');
  const q = (await f.write('post', `/api/surveys/${s.id}/questions/from-library`, { libraryQuestionId: branch.id }).expect(201)).body.data.question;
  await f.write('post', `/api/surveys/${s.id}/publish`).expect(200);
  const anonymous = request.agent(f.app);
  const token = (await anonymous.get('/api/auth/csrf')).body.data.csrfToken;
  for (const value of ['甲文本', '乙文本', '']) await anonymous.post(`/api/public/surveys/${s.id}/responses`).set('X-CSRF-Token', token)
    .send({ answers: value ? [{ questionId: q.id, value }] : [] }).expect(201);
  const n = await f.survey('数字问卷');
  await f.write('post', `/api/surveys/${n.id}/questions/from-library`, { libraryQuestionId: r.id }).expect(201);
  const data = await f.get(`${path}/statistics`);
  assert.equal(data.anonymousResponses, 3); assert.equal(data.uniqueRegisteredRespondents, 0);
  assert.equal(data.visitedCount, 3); assert.equal(data.answeredCount, 2); assert.equal(data.groups.length, 2);
  const text = data.groups.find((g) => g.type === 'text');
  const detail = await f.get(`${path}/statistics?group=${text.id}&pageSize=1&page=2`);
  assert.equal(detail.groups.find((g) => g.type === 'text').contents.items.length, 1);
  assert.equal(detail.groups.find((g) => g.type === 'number').numeric.average, null);
});

test('usage lookup includes related versions, copied/published surveys and every occurrence, excludes removed usages', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const path = `/api/question-library/${record.id}`;
  assert.equal((await f.get(`${path}/usages`)).total, 0);
  const a = await f.survey('旧版问卷');
  const b = await f.survey('新版问卷');
  const importTo = async (s, id = record.id) => (await f.write('post', `/api/surveys/${s.id}/questions/from-library`, { libraryQuestionId: id }).expect(201)).body.data.question;
  const qa = await importTo(a);
  await importTo(a);
  await f.write('post', `/api/surveys/${a.id}/publish`).expect(200);
  const versionId = (await f.get(`${path}/history`)).items[0].id;
  const branch = (await f.write('post', `${path}/versions`, { versionId, question: { title: '新版' } }).expect(201)).body.data;
  const qb = await importTo(b, branch.id);
  await f.write('patch', `/api/surveys/${b.id}/questions/${qb.id}`, { question: { title: '问卷修改版本' } }).expect(200);
  const copy = (await f.write('post', `/api/surveys/${a.id}/copy`).expect(201)).body.data;
  const result = await f.get(`${path}/usages?pageSize=5`);
  assert.equal(result.total, 3);
  assert.equal(result.items.find((s) => s.id === a.id).effectiveStatus, 'published');
  assert.equal(result.items.find((s) => s.id === a.id).questions.length, 2);
  assert.equal(result.items.find((s) => s.id === a.id).questions[0].id, qa.id);
  assert.equal(result.items.find((s) => s.id === b.id).questions[0].title, '问卷修改版本');
  assert.ok(result.items.every((s) => s.questions.every((q) => q.version > 0 && q.versionId)));
  assert.equal((await f.get(`/api/question-library/${branch.id}/usages`)).total, 3);
  await f.write('delete', `/api/surveys/${b.id}/questions/${qb.id}`).expect(200);
  await f.write('delete', `/api/surveys/${copy.id}`).expect(200);
  assert.equal((await f.get(`${path}/usages`)).total, 1);
});

test('usage lookup supports legacy exact matches, stable pagination, owner isolation and strict query validation', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const path = `/api/question-library/${record.id}/usages`;
  for (let i = 0; i < 7; i++) {
    const s = await f.survey(`旧问卷${i}`);
    await f.add(s.id, { title: '年龄', type: 'number', required: true, validation: { min: 0, max: 120, integer: true } });
    await f.add(s.id, { title: '年龄', type: 'number', validation: { min: 1 } });
  }
  const [first, second] = await Promise.all([f.get(`${path}?pageSize=5`), f.get(`${path}?page=2&pageSize=5`)]);
  assert.equal(first.total, 7);
  assert.equal(first.items.length, 5);
  assert.equal(second.items.length, 2);
  assert.equal(new Set([...first.items, ...second.items].map((s) => s.id)).size, 7);
  assert.ok(first.items.every((s) => s.questions.length === 1));
  assert.equal((await f.get(`${path}?page=3&pageSize=5`)).items.length, 0);
  await f.other.agent.get(path).expect(404);
  await request(f.app).get(path).expect(401);
  await f.owner.agent.get(`${path}?page=0`).expect(400);
  await f.owner.agent.get(`${path}?ownerId=forged`).expect(400);
  await f.owner.agent.get('/api/question-library/bad/usages').expect(400);
  const ownRecord = (await f.write('post', '/api/question-library', { question: {
    title: '年龄', type: 'number', required: true, validation: { min: 0, max: 120, integer: true },
  } }, f.other).expect(201)).body.data;
  assert.equal((await f.get(`/api/question-library/${ownRecord.id}/usages`, f.other)).total, 0);
});

test('library and all related surveys share history bidirectionally while each selected snapshot stays fixed', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const a = await f.survey('旧问卷');
  const b = await f.survey('新问卷');
  const imported = async (s) => (await f.write('post', `/api/surveys/${s.id}/questions/from-library`, { libraryQuestionId: record.id }).expect(201)).body.data.question;
  const qa = await imported(a), qb = await imported(b);
  const lib = `/api/question-library/${record.id}`;
  const pa = `/api/surveys/${a.id}/questions/${qa.id}`, pb = `/api/surveys/${b.id}/questions/${qb.id}`;
  await f.write('post', `/api/surveys/${a.id}/publish`).expect(200);
  await f.write('post', `/api/public/surveys/${a.id}/responses`, { answers: [{ questionId: qa.id, value: 25 }] }).expect(201);
  const oldStats = await f.get(`/api/surveys/${a.id}/statistics`);
  const oldSurvey = await f.db.collection('surveys').findOne({ _id: new ObjectId(a.id) });
  await f.write('patch', pb, { question: { title: '问卷分支', validation: { min: 20, max: 90, integer: true } } }).expect(200);
  const fromLibrary = await f.get(`${lib}/history`);
  assert.equal(fromLibrary.total, 2);
  assert.equal(fromLibrary.currentVersion, 1);
  assert.equal(fromLibrary.items[0].question.title, '问卷分支');
  assert.equal((await f.get(`${pb}/history`)).currentVersion, 2);
  await f.write('patch', lib, { question: { title: '题库分支' } }).expect(200);
  const histories = await Promise.all([lib, pa, pb].map((p) => f.get(`${p}/history`)));
  assert.deepEqual(histories.map((h) => h.total), [3, 3, 3]);
  assert.deepEqual(histories.map((h) => h.currentVersion), [3, 1, 2]);
  assert.deepEqual(histories[0].items.map((v) => v.id), histories[1].items.map((v) => v.id));
  assert.deepEqual(histories[1].items.map((v) => v.parentVersion), [1, 1, null]);
  assert.equal(histories[1].canRestore, false);
  await f.write('post', `${pa}/history/restore`, { versionId: histories[0].items[0].id }).expect(409);
  assert.deepEqual(await f.db.collection('surveys').findOne({ _id: new ObjectId(a.id) }), oldSurvey);
  assert.deepEqual(await f.get(`/api/surveys/${a.id}/statistics`), oldStats);
  assert.equal((await f.get(`/api/surveys/${b.id}`)).questions[0].title, '问卷分支');
});

test('branch from any shared version creates independent coexisting library entries and imports the chosen version', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const lib = `/api/question-library/${record.id}`;
  const original = (await f.get(`${lib}/history`)).items[0];
  const branch = (await f.write('post', `${lib}/versions`, { versionId: original.id, question: { title: '新版年龄' } }).expect(201)).body.data;
  assert.notEqual(branch.id, record.id);
  assert.equal((await f.get(lib)).question.title, '年龄');
  assert.equal((await f.get('/api/question-library')).total, 2);
  const history = await f.get(`${lib}/history`);
  assert.equal(history.total, 2);
  assert.equal(history.items[0].parentVersion, 1);
  assert.equal(branch.version, 2);
  const repeated = (await f.write('post', `${lib}/versions`, { versionId: original.id, question: { title: '新版年龄' } }).expect(201)).body.data;
  assert.equal(repeated.id, branch.id);
  assert.equal((await f.get(`${lib}/history`)).total, 2);
  const s = await f.survey();
  const selected = (await f.write('post', `/api/surveys/${s.id}/questions/from-library`, {
    libraryQuestionId: record.id, versionId: history.items[0].id,
  }).expect(201)).body.data.question;
  assert.equal(selected.title, '新版年龄');
  const path = `/api/surveys/${s.id}/questions/${selected.id}`;
  assert.equal((await f.get(`${path}/history`)).total, 2);
  assert.equal((await f.get(`${path}/history`)).currentVersion, 2);
  await f.write('patch', path, { question: { title: '问卷专用版本' } }).expect(200);
  const shared = await f.get(`${lib}/history`);
  assert.equal(shared.total, 3);
  assert.equal(shared.items[0].parentVersion, 2);
  await f.write('post', `${lib}/history/restore`, { versionId: shared.items[0].id }).expect(200);
  assert.equal((await f.get(lib)).question.title, '问卷专用版本');
  assert.equal((await f.get(`/api/question-library/${branch.id}`)).question.title, '新版年龄');
  const finalHistory = await f.get(`${path}/history`);
  assert.equal(finalHistory.total, 4);
  assert.equal(finalHistory.currentVersion, 3);
  assert.equal(finalHistory.items[0].restoredFromVersion, 3);
});

test('save-to-library connects existing content and survives source or branch deletion without losing shared history', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const s = await f.survey();
  const q = await f.add(s.id, { title: '年龄', type: 'number', required: true, validation: { min: 0, max: 120, integer: true } });
  const path = `/api/surveys/${s.id}/questions/${q.id}`;
  assert.equal((await f.write('post', `${path}/save-to-library`).expect(201)).body.data.id, record.id);
  await f.write('patch', path, { question: { title: '独立问卷新版本' } }).expect(200);
  const lib = `/api/question-library/${record.id}`;
  const history = await f.get(`${lib}/history`);
  assert.equal(history.total, 2);
  await f.write('delete', `/api/surveys/${s.id}`).expect(200);
  const archived = await f.get(`${lib}/history`);
  assert.deepEqual(archived.items.map((v) => v.id), history.items.map((v) => v.id));
  const branch = (await f.write('post', `${lib}/versions`, { versionId: archived.items[0].id, question: { title: '存档派生版' } }).expect(201)).body.data;
  await f.write('delete', `/api/question-library/${branch.id}`).expect(200);
  assert.equal((await f.get(`${lib}/history`)).total, 3);
});

test('concurrent sibling branches have unique shared versions and stable parents without changing root content', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const path = `/api/question-library/${record.id}`;
  const versionId = (await f.get(`${path}/history`)).items[0].id;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => f.write('post', `${path}/versions`, {
    versionId, question: { title: `并存分支${i}` },
  })));
  assert.ok(results.every((r) => r.status === 201));
  const history = await f.get(`${path}/history?pageSize=100`);
  assert.equal(history.total, 7);
  assert.equal(new Set(history.items.map((v) => v.number)).size, 7);
  assert.ok(history.items.filter((v) => v.id !== versionId).every((v) => v.parentVersion === 1));
  assert.equal((await f.get(path)).question.title, '年龄');
  assert.equal((await f.get(`${path}/history?page=2&pageSize=5`)).items.length, 2);
});

test('shared version import/branch enforce owner, CSRF, version membership and payload validation', async (t) => {
  const f = await setup(t);
  const a = await f.library('A'), b = await f.library('B');
  const path = `/api/question-library/${a.id}`;
  const versionId = (await f.get(`${path}/history`)).items[0].id;
  const foreignVersion = (await f.get(`/api/question-library/${b.id}/history`)).items[0].id;
  const body = { versionId, question: { title: 'branch' } };
  await request(f.app).post(`${path}/versions`).send(body).expect(403);
  await f.write('post', `${path}/versions`, body, f.other).expect(404);
  await f.owner.agent.post(`${path}/versions`).send(body).expect(403);
  await f.write('post', `${path}/versions`, { ...body, origin: {} }).expect(400);
  await f.write('post', `${path}/versions`, { ...body, versionId: 'bad' }).expect(400);
  await f.write('post', `${path}/versions`, { ...body, versionId: foreignVersion }).expect(404);
  const s = await f.survey();
  const importPath = `/api/surveys/${s.id}/questions/from-library`;
  await f.write('post', importPath, { libraryQuestionId: a.id, versionId: foreignVersion }).expect(404);
  await f.write('post', importPath, { libraryQuestionId: a.id, versionId: 'bad' }).expect(400);
  await f.write('post', `${path}/share`, { username: 'version_other' }).expect(200);
  const notice = (await f.get('/api/notifications', f.other)).items[0];
  await f.write('post', `/api/notifications/${notice.id}/accept`, undefined, f.other).expect(200);
  await f.write('post', `${path}/versions`, body).expect(201);
  const received = (await f.get('/api/question-library', f.other)).items[0];
  assert.equal((await f.get(`/api/question-library/${received.id}/history`, f.other)).total, 1);
  assert.equal((await f.get(`/api/question-library/${b.id}/history`)).total, 1);
});

test('legacy survey questions without provenance link by exact initial content and retain the link after edits', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const s = await f.survey();
  const q = await f.add(s.id, { title: '年龄', type: 'number', required: true, validation: { min: 0, max: 120, integer: true } });
  await f.db.collection('surveys').updateOne({ _id: new ObjectId(s.id) }, { $unset: { questionHistories: '' } });
  await f.db.collection('questionVersionSources').deleteMany({ questionId: q.id });
  const path = `/api/surveys/${s.id}/questions/${q.id}`;
  const lib = `/api/question-library/${record.id}`;
  await f.write('patch', lib, { question: { title: '题库升级' } }).expect(200);
  const legacy = await f.get(`${path}/history`);
  assert.equal(legacy.total, 2);
  assert.equal(legacy.currentVersion, 1);
  assert.equal(legacy.origin.sourceId, record.id);
  await f.write('patch', path, { question: { title: '旧问卷新分支' } }).expect(200);
  assert.equal((await f.get(`${lib}/history`)).total, 3);
  const local = await f.db.collection('surveys').findOne({ _id: new ObjectId(s.id) });
  assert.equal(local.questionHistories[0].history.origin.questionId, record.question.id);
  assert.equal((await f.get(lib)).question.title, '题库升级');
  const unrelated = await f.add(s.id, { title: '年龄', type: 'number', validation: { min: 1 } });
  assert.equal((await f.get(`/api/surveys/${s.id}/questions/${unrelated.id}/history`)).total, 1);
});

test('copy published survey remaps question/option/rule IDs, always starts draft and preserves old responses/statistics', async (t) => {
  const f = await setup(t);
  const s = await f.survey();
  const single = await f.add(s.id, { title: '单选', type: 'single', required: true, options: [{ label: '甲' }, { label: '乙' }] });
  const multiple = await f.add(s.id, { title: '多选', type: 'multiple', options: [{ label: 'A' }, { label: 'B' }], validation: { maxSelections: 2 } });
  const number = await f.add(s.id, { title: '数字', type: 'number', validation: { min: 0, max: 100, integer: true } });
  const text = await f.add(s.id, { title: '文本', type: 'text', validation: { maxLength: 20 } });
  await f.write('put', `/api/surveys/${s.id}/jump-rules`, { rules: [
    { sourceQuestionId: single.id, operator: 'equals', value: single.options[0].id, targetQuestionId: multiple.id, priority: 0 },
    { sourceQuestionId: multiple.id, operator: 'contains_any', value: multiple.options.map((o) => o.id), targetQuestionId: number.id, priority: 0 },
    { sourceQuestionId: multiple.id, operator: 'contains_all', value: [multiple.options[1].id], targetQuestionId: 'END', priority: 1 },
    { sourceQuestionId: number.id, operator: 'greater_than', value: 10, targetQuestionId: text.id, priority: 0 },
  ] }).expect(200);
  await f.write('post', `/api/surveys/${s.id}/publish`).expect(200);
  await f.write('post', `/api/public/surveys/${s.id}/responses`, { answers: [
    { questionId: single.id, value: single.options[0].id }, { questionId: multiple.id, value: [multiple.options[0].id] },
    { questionId: number.id, value: 5 }, { questionId: text.id, value: '旧数据' },
  ] }).expect(201);
  const before = await f.db.collection('surveys').findOne({ _id: new ObjectId(s.id) });
  const oldResponses = await f.db.collection('responses').find({ surveyId: before._id }).toArray();
  const oldStats = await f.get(`/api/surveys/${s.id}/statistics`);
  const copied = (await f.write('post', `/api/surveys/${s.id}/copy`).expect(201)).body.data;
  assert.notEqual(copied.id, s.id);
  assert.equal(copied.status, 'draft');
  assert.equal(copied.publishedAt, null);
  assert.equal(copied.closedAt, null);
  assert.equal(copied.deadline, null);
  assert.equal(copied.title, '问卷（副本）');
  assert.deepEqual(copied.questions.map((q) => q.validation), before.questions.map((q) => q.validation));
  assert.ok(copied.questions.every((q, i) => q.id !== before.questions[i].id));
  assert.ok(copied.jumpRules.every((r, i) => r.id !== before.jumpRules[i].id));
  const [a, b, c, d] = copied.questions;
  assert.equal(copied.jumpRules[0].sourceQuestionId, a.id);
  assert.equal(copied.jumpRules[0].value, a.options[0].id);
  assert.equal(copied.jumpRules[0].targetQuestionId, b.id);
  assert.deepEqual(copied.jumpRules[1].value, b.options.map((o) => o.id));
  assert.deepEqual(copied.jumpRules[2].value, [b.options[1].id]);
  assert.equal(copied.jumpRules[2].targetQuestionId, 'END');
  assert.equal(copied.jumpRules[3].value, 10);
  assert.equal(copied.jumpRules[3].targetQuestionId, d.id);
  assert.equal((await f.get(`/api/surveys/${copied.id}/statistics`)).totalResponses, 0);
  await f.owner.agent.get(`/api/public/surveys/${copied.id}`).expect(404);
  await f.write('patch', `/api/surveys/${copied.id}/questions/${a.id}`, { question: { title: '新单选' } }).expect(200);
  await f.write('patch', `/api/surveys/${s.id}/questions/${single.id}`, { question: { title: '不允许' } }).expect(409);
  assert.deepEqual(await f.db.collection('surveys').findOne({ _id: before._id }), before);
  assert.deepEqual(await f.db.collection('responses').find({ surveyId: before._id }).toArray(), oldResponses);
  assert.deepEqual(await f.get(`/api/surveys/${s.id}/statistics`), oldStats);
});

test('copy supports empty/draft/closed/expired surveys and safe Unicode title length', async (t) => {
  const f = await setup(t);
  for (const status of ['draft', 'published', 'closed']) {
    const s = await f.survey('𠮷'.repeat(200));
    await f.db.collection('surveys').updateOne({ _id: new ObjectId(s.id) }, { $set: {
      status, deadline: new Date(0), publishedAt: status === 'draft' ? null : new Date(0), closedAt: new Date(0), seedTag: 'not-copied',
    } });
    const copy = (await f.write('post', `/api/surveys/${s.id}/copy`).expect(201)).body.data;
    assert.equal(copy.status, 'draft');
    assert.deepEqual(copy.questions, []);
    assert.equal(copy.deadline, null);
    assert.equal(copy.publishedAt, null);
    assert.equal(copy.closedAt, null);
    assert.equal(copy.seedTag, undefined);
    assert.equal([...copy.title].length, 200);
    assert.ok(copy.title.endsWith('（副本）'));
  }
});

test('copy authorization and input whitelist cannot create published or foreign drafts', async (t) => {
  const f = await setup(t);
  const s = await f.survey();
  const path = `/api/surveys/${s.id}/copy`;
  await f.write('post', path, undefined, f.other).expect(404);
  await f.owner.agent.post(path).send({}).expect(403);
  const anonymous = request.agent(f.app);
  const csrf = (await anonymous.get('/api/auth/csrf')).body.data.csrfToken;
  await anonymous.post(path).set('X-CSRF-Token', csrf).send({}).expect(401);
  await f.write('post', path, { status: 'published' }).expect(400);
  await f.write('post', `${path}?ownerId=forged`).expect(400);
  await f.write('post', '/api/surveys/bad/copy').expect(400);
  await f.write('post', `/api/surveys/${new ObjectId()}/copy`).expect(404);
  assert.equal(await f.db.collection('surveys').countDocuments(), 1);
});

test('library versions form a parent chain; restore appends a new version based on an old snapshot', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const path = `/api/question-library/${record.id}`;
  await f.write('patch', path, { question: { title: '年龄二版' } }).expect(200);
  await f.write('patch', path, { question: { title: '年龄三版', validation: { min: 20, max: 120, integer: true } } }).expect(200);
  const before = await f.get(`${path}/history`);
  assert.deepEqual(before.items.map((v) => v.number), [3, 2, 1]);
  assert.deepEqual(before.items.map((v) => v.parentVersion), [2, 1, null]);
  const first = before.items[2];
  await f.write('post', `${path}/history/restore`, { versionId: first.id }).expect(200);
  const current = await f.get(path);
  assert.equal(current.question.title, '年龄');
  assert.equal(current.question.validation.min, 0);
  assert.equal(current.version, 4);
  assert.equal(current.questionHistory, undefined);
  const after = await f.get(`${path}/history`);
  assert.equal(after.items[0].parentVersion, 3);
  assert.equal(after.items[0].basedOnVersion, 1);
  assert.equal(after.items[0].restoredFromVersion, 1);
  assert.deepEqual(after.items.slice(1).map((v) => v.id), before.items.map((v) => v.id));
  await f.write('patch', path, { question: { title: '年龄' } }).expect(200);
  assert.equal((await f.get(`${path}/history`)).total, 4);
  assert.equal((await f.get(`${path}/history?page=2&pageSize=2`)).items.length, 2);
  await f.db.collection('questionLibrary').updateOne({ _id: new ObjectId(record.id) }, { $unset: { questionHistory: '' } });
  await f.db.collection('questionVersionSources').deleteMany({ questionId: current.question.id });
  const legacy = await f.get(`${path}/history`);
  assert.equal(legacy.total, 1);
  assert.equal(legacy.items[0].id, current.question.id);
});

test('survey question restore handles old options, cleans invalid rules and is forbidden after publish', async (t) => {
  const f = await setup(t);
  const s = await f.survey();
  const q = await f.add(s.id, { title: '原选择题', type: 'single', options: [{ label: '甲' }, { label: '乙' }] });
  const next = await f.add(s.id, { title: '下一题', type: 'text' });
  const path = `/api/surveys/${s.id}/questions/${q.id}`;
  await f.write('put', `/api/surveys/${s.id}/jump-rules`, { rules: [{
    sourceQuestionId: q.id, operator: 'equals', value: q.options[0].id, targetQuestionId: next.id, priority: 0,
  }] }).expect(200);
  await f.write('patch', path, { question: { title: '数字版', type: 'number' } }).expect(200);
  const first = (await f.get(`${path}/history`)).items[1];
  await f.write('post', `${path}/history/restore`, { versionId: first.id }).expect(200);
  const restored = await f.get(`/api/surveys/${s.id}`);
  assert.deepEqual(restored.questions[0], q);
  assert.deepEqual(restored.jumpRules, []);
  assert.equal(restored.questionHistories, undefined);
  assert.equal((await f.get(`${path}/history`)).currentVersion, 3);
  await f.write('post', `/api/surveys/${s.id}/publish`).expect(200);
  assert.equal((await f.get(`${path}/history`)).canRestore, false);
  await f.write('post', `${path}/history/restore`, { versionId: first.id }).expect(409);
  assert.equal((await f.get(`${path}/history`)).total, 3);
  const publicData = await f.get(`/api/public/surveys/${s.id}`);
  assert.equal(publicData.questionHistories, undefined);
});

test('question provenance records library import, survey copy, save-to-library and shared-source version', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  await f.write('patch', `/api/question-library/${record.id}`, { question: { title: '年龄v2' } }).expect(200);
  const s = await f.survey();
  const q = (await f.write('post', `/api/surveys/${s.id}/questions/from-library`, { libraryQuestionId: record.id }).expect(201)).body.data.question;
  const path = `/api/surveys/${s.id}/questions/${q.id}`;
  const origin = (await f.get(`${path}/history`)).origin;
  assert.equal(origin.kind, 'library');
  assert.equal(origin.sourceId, record.id);
  assert.equal(origin.version, 2);
  await f.write('patch', path, { question: { title: '问卷中v2' } }).expect(200);
  const saved = (await f.write('post', `${path}/save-to-library`).expect(201)).body.data;
  assert.equal(saved.origin.kind, 'survey');
  assert.equal(saved.origin.version, 3);
  const copy = (await f.write('post', `/api/surveys/${s.id}/copy`).expect(201)).body.data;
  const copiedHistory = await f.get(`/api/surveys/${copy.id}/questions/${copy.questions[0].id}/history`);
  assert.equal(copiedHistory.currentVersion, 3);
  assert.equal(copiedHistory.origin.kind, 'survey');
  assert.equal(copiedHistory.origin.version, 3);
  assert.equal(copiedHistory.origin.questionId, q.id);
  await f.write('post', `/api/question-library/${record.id}/share`, { username: 'version_other' }).expect(200);
  const notice = (await f.get('/api/notifications', f.other)).items[0];
  await f.write('post', `/api/notifications/${notice.id}/accept`, undefined, f.other).expect(200);
  const received = (await f.get('/api/question-library', f.other)).items[0];
  assert.equal(received.origin.kind, 'shared');
  assert.equal(received.origin.version, 2);
  assert.equal(received.origin.senderUsername, 'version_owner');
  assert.equal(received.origin.sourceId, undefined);
});

test('library content merge keeps both history branches and restores an older merged snapshot', async (t) => {
  const f = await setup(t);
  const a = await f.library('A');
  const b = await f.library('B');
  await f.write('patch', `/api/question-library/${a.id}`, { question: { title: 'A2' } }).expect(200);
  await f.write('patch', `/api/question-library/${b.id}`, { question: { title: 'B2' } }).expect(200);
  const oldB = (await f.get(`/api/question-library/${b.id}/history`)).items[1];
  const merged = (await f.write('patch', `/api/question-library/${b.id}`, { question: { title: 'A2' } }).expect(200)).body.data;
  assert.equal(merged.id, a.id);
  assert.equal((await f.get('/api/question-library')).total, 1);
  const history = await f.get(`/api/question-library/${a.id}/history`);
  assert.equal(history.total, 5);
  assert.ok(history.items.some((v) => v.id === oldB.id && v.question.title === 'B'));
  await f.write('post', `/api/question-library/${a.id}/history/restore`, { versionId: oldB.id }).expect(200);
  assert.equal((await f.get(`/api/question-library/${a.id}`)).question.title, 'B');
  assert.equal((await f.get(`/api/question-library/${a.id}/history`)).total, 6);
});

test('history endpoints isolate authors, validate versions, and concurrent updates do not lose history', async (t) => {
  const f = await setup(t);
  const record = await f.library();
  const s = await f.survey();
  const q = await f.add(s.id, { title: '题目', type: 'text' });
  for (const path of [`/api/question-library/${record.id}/history`, `/api/surveys/${s.id}/questions/${q.id}/history`]) {
    const first = (await f.get(path)).items[0];
    await f.other.agent.get(path).expect(404);
    await request(f.app).get(path).expect(401);
    await f.write('post', `${path}/restore`, { versionId: first.id }, f.other).expect(404);
    await f.owner.agent.post(`${path}/restore`).send({ versionId: first.id }).expect(403);
    await f.write('post', `${path}/restore`, { versionId: 'bad' }).expect(400);
    await f.write('post', `${path}/restore`, { versionId: q.id === first.id ? record.question.id : q.id }).expect(404);
    await f.write('post', `${path}/restore`, { versionId: first.id, question: {} }).expect(400);
    await f.owner.agent.get(`${path}?page=0`).expect(400);
  }
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    f.write('patch', `/api/question-library/${record.id}`, { question: { title: `并发${i}` } })));
  assert.ok(results.every((r) => [200, 409].includes(r.status)));
  const succeeded = results.filter((r) => r.status === 200).length;
  const history = await f.get(`/api/question-library/${record.id}/history`);
  assert.equal(history.total, succeeded + 1);
  assert.equal(new Set(history.items.map((v) => v.id)).size, history.total);
});
