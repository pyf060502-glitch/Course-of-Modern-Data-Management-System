import session from 'express-session';
import MongoStore from 'connect-mongo';
import bcrypt from 'bcryptjs';
import { ObjectId } from 'mongodb';
import { createCsrfToken, verifyCsrf } from '../middleware/auth.js';
import { HttpError, sendData } from '../middleware/errors.js';
import { assertAllowedFields, assertString, invalidField } from '../validators/basic.js';

export const SESSION_COOKIE_NAME = 'survey.sid';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function credentials(body) {
  assertAllowedFields(body, ['username', 'password']);
  const username = assertString(body.username, 'username', { min: 3, max: 32 });
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
    invalidField('username', 'Username must contain 3-32 ASCII letters, digits, underscores or hyphens');
  }
  const password = assertString(body.password, 'password', { min: 8, trim: false });
  if (Buffer.byteLength(password, 'utf8') > 72) {
    invalidField('password', 'Password must not exceed 72 UTF-8 bytes');
  }
  return { username, usernameNormalized: username.toLowerCase(), password };
}

function userSummary(user) {
  return { id: user._id.toHexString(), username: user.username, createdAt: user.createdAt };
}

function sessionAction(req, method) {
  return new Promise((resolve, reject) => req.session[method]((error) => error ? reject(error) : resolve()));
}

export function registerAuth(app, { db, client, config }) {
  const store = MongoStore.create({
    client, dbName: db.databaseName, collectionName: 'sessions',
    ttl: SESSION_MAX_AGE_MS / 1000, autoRemove: 'native',
  });
  // The client belongs to the application. Closing the store must not close it.
  store.close = async () => {
    if (store.timer) clearInterval(store.timer);
    await store.collectionP;
  };
  app.locals.sessionStore = store;
  app.locals.sessionStoreReady = store.collectionP;
  // Mark initialization failures handled; requests/startup still surface the failure.
  store.collectionP.catch(() => {});
  const cookie = {
    httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production',
    path: '/', maxAge: SESSION_MAX_AGE_MS,
  };
  app.use('/api', session({
    name: SESSION_COOKIE_NAME, secret: config.sessionSecret, store,
    resave: false, saveUninitialized: false, cookie,
  }));
  app.use('/api', async (req, res, next) => {
    req.user = null;
    const id = req.session?.userId;
    if (typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)) {
      req.user = await db.collection('users').findOne(
        { _id: new ObjectId(id) }, { projection: { username: 1, createdAt: 1 } },
      );
      if (!req.user) delete req.session.userId;
    }
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', verifyCsrf);

  app.get('/api/auth/csrf', (req, res) => {
    assertAllowedFields(req.query, [], 'query');
    req.session.csrfToken ??= createCsrfToken();
    return sendData(res, { csrfToken: req.session.csrfToken });
  });
  app.get('/api/auth/me', (req, res) => {
    assertAllowedFields(req.query, [], 'query');
    return sendData(res, { user: req.user ? userSummary(req.user) : null });
  });
  app.post('/api/auth/register', async (req, res) => {
    const { username, usernameNormalized, password } = credentials(req.body);
    const user = {
      username, usernameNormalized, passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date(),
    };
    try {
      const result = await db.collection('users').insertOne(user);
      user._id = result.insertedId;
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, 'USERNAME_TAKEN', 'Username is already registered');
      throw error;
    }
    return sendData(res, { user: userSummary(user) }, 201);
  });
  app.post('/api/auth/login', async (req, res) => {
    const { usernameNormalized, password } = credentials(req.body);
    const user = await db.collection('users').findOne({ usernameNormalized });
    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    }
    await sessionAction(req, 'regenerate');
    req.session.userId = user._id.toHexString();
    req.session.csrfToken = createCsrfToken();
    await sessionAction(req, 'save');
    return sendData(res, { user: userSummary(user), csrfToken: req.session.csrfToken });
  });
  app.post('/api/auth/logout', async (req, res) => {
    if (req.body !== undefined) assertAllowedFields(req.body, []);
    await sessionAction(req, 'destroy');
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, secure: cookie.secure, path: cookie.path,
    });
    return sendData(res, { loggedOut: true });
  });
  return store;
}
