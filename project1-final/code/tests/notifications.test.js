import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { createTestDatabase } from './helpers/database.js';
import { createNotificationService } from '../src/services/notifications.js';

async function setup(t) {
  const f = await createTestDatabase();
  const app = createApp(f);
  t.after(async () => { try { await app.locals.sessionStore.close(); } finally { await f.cleanup(); } });
  await app.locals.sessionStoreReady;
  const users = [];
  for (const username of ['notify_sender', 'notify_recipient', 'notify_third']) {
    const agent = request.agent(app);
    const token = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
    await agent.post('/api/auth/register').set('X-CSRF-Token', token).send({ username, password: 'password123' }).expect(201);
    const login = (await agent.post('/api/auth/login').set('X-CSRF-Token', token)
      .send({ username, password: 'password123' }).expect(200)).body.data;
    users.push({ agent, id: new ObjectId(login.user.id), token: login.csrfToken });
  }
  const [sender, recipient, third] = users;
  const write = (method, url, body, user = recipient) => user.agent[method](url).set('X-CSRF-Token', user.token).send(body);
  async function share(title = '分享年龄') {
    const source = (await write('post', '/api/question-library', { question: {
      title, type: 'number', required: true, validation: { min: 0, max: 120, integer: true },
    } }, sender).expect(201)).body.data;
    await write('post', `/api/question-library/${source.id}/share`, { username: 'notify_recipient' }, sender).expect(200);
    const notice = await f.db.collection('notifications').findOne({ recipientId: recipient.id, 'question.title': title });
    return { source, notice };
  }
  return { ...f, app, sender, recipient, third, write, share };
}

test('received notifications require explicit acceptance and keep a snapshot after sender edits/deletes source', async (t) => {
  const f = await setup(t);
  const { source, notice } = await f.share();
  assert.equal((await f.recipient.agent.get('/api/question-library')).body.data.total, 0);
  const list = (await f.recipient.agent.get('/api/notifications').expect(200)).body.data;
  assert.equal(list.total, 1);
  assert.equal(list.items[0].senderUsername, 'notify_sender');
  assert.equal(list.items[0].status, 'pending');
  assert.equal(list.items[0].canAccept, true);
  for (const field of ['recipientId', 'senderId', 'contentKey', 'operationId', 'leaseUntil']) assert.equal(list.items[0][field], undefined);
  await f.write('patch', `/api/question-library/${source.id}`, { question: { title: '原题被改动' } }, f.sender).expect(200);
  await f.write('delete', `/api/question-library/${source.id}`, undefined, f.sender).expect(200);
  await f.write('post', `/api/notifications/${notice._id}/accept`).expect(200);
  const received = (await f.recipient.agent.get('/api/question-library')).body.data.items[0];
  assert.equal(received.question.title, '分享年龄');
  assert.deepEqual(received.question.validation, source.question.validation);
  assert.notEqual(received.question.id, source.question.id);
  assert.equal((await f.recipient.agent.get('/api/notifications')).body.data.items[0].status, 'accepted');
});

test('notification listing/accept/delete require recipient auth, CSRF and strict input', async (t) => {
  const f = await setup(t);
  const { notice } = await f.share();
  const base = `/api/notifications/${notice._id}`;
  await request(f.app).get('/api/notifications').expect(401);
  for (const user of [f.sender, f.third]) {
    assert.equal((await user.agent.get('/api/notifications')).body.data.total, 0);
    await f.write('post', `${base}/accept`, undefined, user).expect(404);
    await f.write('delete', base, undefined, user).expect(404);
  }
  await f.recipient.agent.post(`${base}/accept`).send({}).expect(403);
  await f.recipient.agent.delete(base).expect(403);
  await f.write('post', `${base}/accept`, { recipientId: String(f.sender.id) }).expect(400);
  await f.write('delete', `${base}?force=true`).expect(400);
  await f.write('post', '/api/notifications/bad/accept').expect(400);
  await f.write('delete', `/api/notifications/${new ObjectId()}`).expect(404);
  await f.recipient.agent.get('/api/notifications?pageSize=101').expect(400);
  await f.recipient.agent.get('/api/notifications?page=0').expect(400);
  await f.recipient.agent.get('/api/notifications?recipientId=forged').expect(400);
  assert.equal(await f.db.collection('questionLibrary').countDocuments({ ownerId: f.recipient.id }), 0);
  assert.equal((await f.db.collection('notifications').findOne({ _id: notice._id })).status, 'pending');
});

test('declining deletes only the notification; accepted-history deletion leaves the personal library intact', async (t) => {
  const f = await setup(t);
  const { source, notice } = await f.share();
  await f.write('delete', `/api/notifications/${notice._id}`).expect(200);
  await f.write('post', `/api/notifications/${notice._id}/accept`).expect(404);
  assert.equal((await f.recipient.agent.get('/api/question-library')).body.data.total, 0);
  await f.sender.agent.get(`/api/question-library/${source.id}`).expect(200);
  await f.write('post', `/api/question-library/${source.id}/share`, { username: 'notify_recipient' }, f.sender).expect(200);
  const next = (await f.recipient.agent.get('/api/notifications')).body.data.items[0];
  assert.notEqual(next.id, String(notice._id));
  await f.write('post', `/api/notifications/${next.id}/accept`).expect(200);
  await f.write('delete', `/api/notifications/${next.id}`).expect(200);
  assert.equal((await f.recipient.agent.get('/api/notifications')).body.data.total, 0);
  assert.equal((await f.recipient.agent.get('/api/question-library')).body.data.total, 1);
});

test('concurrent acceptance deduplicates and active processing blocks deletion', async (t) => {
  const f = await setup(t);
  const { notice } = await f.share();
  const url = `/api/notifications/${notice._id}`;
  const results = await Promise.all(Array.from({ length: 6 }, () => f.write('post', `${url}/accept`)));
  assert.ok(results.every((result) => [200, 409].includes(result.status)));
  assert.ok(results.some((result) => result.status === 200));
  await f.write('post', `${url}/accept`).expect(200);
  assert.equal((await f.recipient.agent.get('/api/question-library')).body.data.total, 1);
  const next = await f.share('另一题');
  await f.db.collection('notifications').updateOne({ _id: next.notice._id }, { $set: {
    status: 'accepting', operationId: 'other-operation', leaseUntil: new Date(Date.now() + 30000),
  } });
  await f.write('delete', `/api/notifications/${next.notice._id}`).expect(409);
  await f.write('post', `/api/notifications/${next.notice._id}/accept`).expect(409);
  await f.db.collection('notifications').updateOne({ _id: next.notice._id }, { $set: { leaseUntil: new Date(0) } });
  await f.write('post', `/api/notifications/${next.notice._id}/accept`).expect(200);
  assert.equal((await f.recipient.agent.get('/api/question-library')).body.data.total, 2);
});

test('failed acceptance restores pending state and retry is safe; notification pages are stable', async (t) => {
  const f = await setup(t);
  const { notice } = await f.share();
  let fail = true;
  const proxyDb = { collection(name) {
    const collection = f.db.collection(name);
    if (name !== 'questionLibrary') return collection;
    return new Proxy(collection, { get(target, key) {
      if (key === 'findOneAndUpdate') return (...args) => {
        if (fail) { fail = false; throw new Error('Simulated database failure'); }
        return target.findOneAndUpdate(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const service = createNotificationService(proxyDb);
  await assert.rejects(service.accept(String(notice._id), f.recipient.id), /Simulated database failure/);
  const pending = await f.db.collection('notifications').findOne({ _id: notice._id });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.operationId, undefined);
  assert.equal(pending.leaseUntil, undefined);
  await service.accept(String(notice._id), f.recipient.id);
  for (let i = 0; i < 6; i++) await f.share(`分页题${i}`);
  const first = (await f.recipient.agent.get('/api/notifications?page=1&pageSize=5')).body.data;
  const second = (await f.recipient.agent.get('/api/notifications?page=2&pageSize=5')).body.data;
  assert.equal(first.items.length, 5);
  assert.equal(second.items.length, 2);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 7);
  assert.equal(first.total, 7);
  await request(f.app).get('/notifications').expect(200);
  await request(f.app).get('/js/notifications.js').expect(200);
});

test('badge count isolates recipients and counts only pending/accepting until accept or delete', async (t) => {
  const f = await setup(t);
  const count = async (user = f.recipient) => (await user.agent.get('/api/notifications/count').expect(200)).body.data.pendingCount;
  assert.equal(await count(), 0);
  const first = await f.share();
  const second = await f.share('第二条');
  assert.equal(await count(), 2);
  assert.equal(await count(f.sender), 0);
  assert.equal(await count(f.third), 0);
  await f.write('post', `/api/question-library/${first.source.id}/share`, { username: 'notify_recipient' }, f.sender).expect(200);
  assert.equal(await count(), 2);
  await f.write('post', `/api/notifications/${first.notice._id}/accept`).expect(200);
  assert.equal(await count(), 1);
  assert.equal((await f.recipient.agent.get('/api/notifications')).body.data.total, 2);
  await f.write('delete', `/api/notifications/${first.notice._id}`).expect(200);
  assert.equal(await count(), 1);
  await f.db.collection('notifications').updateOne({ _id: second.notice._id }, { $set: {
    status: 'accepting', leaseUntil: new Date(0), operationId: 'expired',
  } });
  assert.equal(await count(), 1);
  await f.write('post', `/api/notifications/${second.notice._id}/accept`).expect(200);
  assert.equal(await count(), 0);
  const third = await f.share('删除待处理');
  assert.equal(await count(), 1);
  await f.write('delete', `/api/notifications/${third.notice._id}`).expect(200);
  assert.equal(await count(), 0);
  await request(f.app).get('/api/notifications/count').expect(401);
  await f.recipient.agent.get(`/api/notifications/count?recipientId=${f.sender.id}`).expect(400);
  assert.ok((await f.db.collection('notifications').indexes()).some((index) => index.name === 'notifications_recipient_status'));
});
