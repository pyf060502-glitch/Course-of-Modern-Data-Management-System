import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { registerAuth, SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from '../src/routes/auth.js';
import { requireAuth, requireSurveyOwner, getOwnedSurvey } from '../src/middleware/auth.js';
import { sendData } from '../src/middleware/errors.js';
import { createTestDatabase } from './helpers/database.js';

async function setup(t, { protectedRoutes = false, production = false } = {}) {
  const fixture = await createTestDatabase();
  const apps = [];
  t.after(async () => {
    try {
      for (const app of apps) await app.locals.sessionStore?.close();
    } finally {
      await fixture.cleanup();
    }
  });
  const config = { ...fixture.config, nodeEnv: production ? 'production' : 'test' };
  function makeApp() {
    const app = createApp({
      ...fixture, config,
      ...(protectedRoutes ? {
        registerRoutes(app, dependencies) {
          registerAuth(app, dependencies);
          app.get('/api/test/private', requireAuth, (req, res) => sendData(res, { id: req.user._id }));
          app.post('/api/test/private', requireAuth, (req, res) => sendData(res, { ok: true }));
          app.get('/api/test/owned/:surveyId', requireSurveyOwner,
            (req, res) => sendData(res, { id: req.survey._id }));
        },
      } : {}),
    });
    if (production) app.set('trust proxy', 1);
    apps.push(app);
    return app;
  }
  const app = makeApp();
  await app.locals.sessionStoreReady;
  return { ...fixture, app, makeApp };
}

async function csrf(agent) {
  return (await agent.get('/api/auth/csrf').expect(200)).body.data.csrfToken;
}

function register(agent, token, username = 'Alice', password = 'password123') {
  return agent.post('/api/auth/register').set('X-CSRF-Token', token)
    .send({ username, password });
}

function login(agent, token, username = 'alice', password = 'password123') {
  return agent.post('/api/auth/login').set('X-CSRF-Token', token)
    .send({ username, password });
}

function cookieOf(response) {
  return response.headers['set-cookie'][0].split(';')[0];
}

test('registration persists bcrypt hash, normalizes ASCII username and never logs in automatically', async (t) => {
  const { app, db } = await setup(t);
  const agent = request.agent(app);
  const token = await csrf(agent);
  const result = await register(agent, token, '  Alice_-  ', ' password123 ').expect(201);
  assert.deepEqual(Object.keys(result.body.data.user).sort(), ['createdAt', 'id', 'username']);
  assert.equal(result.body.data.user.username, 'Alice_-');
  const user = await db.collection('users').findOne({ usernameNormalized: 'alice_-' });
  assert.equal(user.username, 'Alice_-');
  assert.ok(user.createdAt instanceof Date);
  assert.notEqual(user.passwordHash, ' password123 ');
  assert.equal(await bcrypt.compare(' password123 ', user.passwordHash), true);
  assert.equal(await bcrypt.compare('password123', user.passwordHash), false);
  assert.equal((await agent.get('/api/auth/me').expect(200)).body.data.user, null);
  await login(agent, token, 'ALICE_-', ' password123 ').expect(200);
});

test('duplicate normalized registrations including concurrent requests return 409', async (t) => {
  const { app, db } = await setup(t);
  const agents = [request.agent(app), request.agent(app)];
  const tokens = await Promise.all(agents.map(csrf));
  const results = await Promise.all(agents.map((agent, i) =>
    register(agent, tokens[i], i ? 'ALICE' : 'Alice')));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(await db.collection('users').countDocuments({ usernameNormalized: 'alice' }), 1);
  const duplicate = await register(agents[0], tokens[0], ' alice ').expect(409);
  assert.equal(duplicate.body.error.code, 'USERNAME_TAKEN');
});

test('credential validation rejects invalid characters, types, fields and bcrypt byte overflow', async (t) => {
  const { app } = await setup(t);
  const agent = request.agent(app);
  const token = await csrf(agent);
  for (const body of [
    { username: 'ab', password: 'password123' },
    { username: 'a'.repeat(33), password: 'password123' },
    ...['中文名字', 'a b', 'abc.', 'abc@', '😀abc'].map((username) => ({ username, password: 'password123' })),
    { username: { $ne: null }, password: 'password123' },
    { username: 'Alice', password: 12345678 },
    { username: 'Alice', password: '1234567' },
    { username: 'Alice', password: 'a'.repeat(73) },
    { username: 'Alice', password: '😀'.repeat(19) },
    { username: 'Alice', password: 'password123', ownerId: 'forged' },
  ]) {
    await agent.post('/api/auth/register').set('X-CSRF-Token', token).send(body).expect(400);
  }
  await register(agent, token, 'byte-max', '😀'.repeat(18)).expect(201);
  await register(agent, token, 'ascii-max', 'a'.repeat(72)).expect(201);
  await register(agent, token, 'space-pass', '        ').expect(201);
});

test('login rotates Cookie and CSRF, rejects wrong credentials, and logout invalidates stored session', async (t) => {
  const { app, db } = await setup(t);
  const agent = request.agent(app);
  const first = await agent.get('/api/auth/csrf').expect(200);
  const token = first.body.data.csrfToken;
  const oldCookie = cookieOf(first);
  assert.match(first.headers['set-cookie'][0], /HttpOnly/);
  assert.match(first.headers['set-cookie'][0], /SameSite=Lax/);
  assert.doesNotMatch(first.headers['set-cookie'][0], /;\s*Secure/);
  await register(agent, token).expect(201);
  for (const [name, password] of [['alice', 'wrongpass'], ['unknown', 'password123']]) {
    const wrong = await login(agent, token, name, password).expect(401);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  }
  const result = await login(agent, token).expect(200);
  const newToken = result.body.data.csrfToken;
  const newCookie = cookieOf(result);
  assert.notEqual(oldCookie, newCookie);
  assert.notEqual(token, newToken);
  assert.equal((await csrf(agent)), newToken);
  assert.equal(await db.collection('sessions').countDocuments(), 1);
  const stored = await db.collection('sessions').findOne({});
  assert.equal(JSON.parse(stored.session).userId, result.body.data.user.id);
  assert.equal(JSON.parse(stored.session).passwordHash, undefined);
  assert.equal((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).body.data.user, null);
  assert.equal((await agent.get('/api/auth/me')).body.data.user.username, 'Alice');
  await agent.post('/api/auth/logout').set('X-CSRF-Token', token).expect(403);
  const logout = await agent.post('/api/auth/logout').set('X-CSRF-Token', newToken).expect(200);
  assert.match(logout.headers['set-cookie'][0], new RegExp(`^${SESSION_COOKIE_NAME}=`));
  assert.match(logout.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
  assert.equal(await db.collection('sessions').countDocuments(), 0);
  assert.equal((await request(app).get('/api/auth/me').set('Cookie', newCookie)).body.data.user, null);
  assert.equal((await agent.get('/api/auth/me')).body.data.user, null);
  // Logout is idempotent for an anonymous session, while still requiring CSRF.
  const anonymousToken = await csrf(agent);
  await agent.post('/api/auth/logout').set('X-CSRF-Token', anonymousToken).expect(200);
});

test('CSRF binds token to session and protects all API mutations including anonymous requests', async (t) => {
  const { app } = await setup(t, { protectedRoutes: true });
  const alice = request.agent(app);
  const bob = request.agent(app);
  const token = await csrf(alice);
  await csrf(bob);
  for (const supplied of [undefined, '', 'bad', 'a'.repeat(64)]) {
    let req = alice.post('/api/auth/register').send({ username: 'Alice', password: 'password123' });
    if (supplied !== undefined) req = req.set('X-CSRF-Token', supplied);
    await req.expect(403);
  }
  await register(bob, token).expect(403);
  await request(app).post('/api/auth/register').set('X-CSRF-Token', token)
    .send({ username: 'Alice', password: 'password123' }).expect(403);
  await alice.post('/api/test/private').expect(403);
  await alice.post('/api/test/private').set('X-CSRF-Token', token).expect(401);
  await register(alice, token).expect(201);
  const result = await login(alice, token).expect(200);
  await alice.post('/api/test/private').set('X-CSRF-Token', token).expect(403);
  await alice.post('/api/test/private').set('X-CSRF-Token', result.body.data.csrfToken).expect(200);
});

test('requireAuth and compound owner query isolate users and reject missing or invalid IDs', async (t) => {
  const { app, db } = await setup(t, { protectedRoutes: true });
  const agents = [request.agent(app), request.agent(app)];
  const ids = [];
  await request(app).get('/api/test/private').expect(401);
  for (const [i, agent] of agents.entries()) {
    const token = await csrf(agent);
    await register(agent, token, `user${i}`).expect(201);
    ids.push((await login(agent, token, `user${i}`).expect(200)).body.data.user.id);
    await agent.get('/api/test/private').expect(200);
  }
  const survey = { _id: new ObjectId(), ownerId: new ObjectId(ids[0]), title: 'Private' };
  await db.collection('surveys').insertOne(survey);
  await agents[0].get(`/api/test/owned/${survey._id}`).expect(200);
  await agents[1].get(`/api/test/owned/${survey._id}`).expect(404);
  await request(app).get(`/api/test/owned/${survey._id}`).expect(401);
  await agents[0].get('/api/test/owned/bad').expect(400);
  await agents[0].get(`/api/test/owned/${new ObjectId()}`).expect(404);
  assert.equal((await getOwnedSurvey(db, survey._id, ids[0])).title, 'Private');
  await assert.rejects(getOwnedSurvey(db, survey._id, ids[1]), { status: 404 });
  await assert.rejects(getOwnedSurvey(db, survey._id, null), { status: 401 });
});

test('sessions persist across app recreation, use native TTL, and expired sessions cannot authenticate', async (t) => {
  const { app, db, client, makeApp } = await setup(t);
  const agent = request.agent(app);
  const token = await csrf(agent);
  await register(agent, token).expect(201);
  const result = await login(agent, token).expect(200);
  const cookie = cookieOf(result);
  const stored = await db.collection('sessions').findOne({});
  assert.ok(stored.expires instanceof Date);
  assert.ok(Math.abs(stored.expires.getTime() - Date.now() - SESSION_MAX_AGE_MS) < 5000);
  const index = (await db.collection('sessions').listIndexes().toArray())
    .find((item) => item.key.expires === 1);
  assert.equal(index.expireAfterSeconds, 0);
  assert.equal(app.locals.sessionStore.timer, undefined);
  await app.locals.sessionStore.close();
  assert.equal((await db.command({ ping: 1 })).ok, 1);
  const second = makeApp();
  await second.locals.sessionStoreReady;
  assert.equal(await second.locals.sessionStore.clientP, client);
  const me = await request(second).get('/api/auth/me').set('Cookie', cookie).expect(200);
  assert.equal(me.body.data.user.id, result.body.data.user.id);
  await db.collection('sessions').updateOne({ _id: stored._id }, { $set: { expires: new Date(0) } });
  const expired = await request(second).get('/api/auth/me').set('Cookie', cookie).expect(200);
  assert.equal(expired.body.data.user, null);
});

test('production Cookie is Secure over HTTPS and anonymous me does not create sessions', async (t) => {
  const { app, db } = await setup(t, { production: true });
  const me = await request(app).get('/api/auth/me').expect(200);
  assert.equal(me.headers['set-cookie'], undefined);
  assert.equal(await db.collection('sessions').countDocuments(), 0);
  const result = await request(app).get('/api/auth/csrf').set('X-Forwarded-Proto', 'https').expect(200);
  assert.match(result.headers['set-cookie'][0], /;\s*Secure/);
  assert.match(result.headers['set-cookie'][0], /HttpOnly/);
  assert.match(result.headers['set-cookie'][0], /SameSite=Lax/);
  assert.equal(result.headers['cache-control'], 'no-store');
});
