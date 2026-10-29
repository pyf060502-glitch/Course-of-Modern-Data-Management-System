import { randomUUID } from 'node:crypto';
import { assertDatabaseName, assertMongoUri } from '../../src/config.js';
import { connectDatabase } from '../../src/db/connection.js';

export function testDatabaseConfig(env = process.env) {
  const prefix = env.TEST_MONGODB_DB ?? 'survey_test_integration';
  assertDatabaseName(prefix, 'TEST_MONGODB_DB');
  if (!/^survey_test_[A-Za-z0-9_-]+$/.test(prefix) || prefix.length > 38) {
    throw new Error('TEST_MONGODB_DB must use survey_test_ prefix and be at most 38 characters');
  }
  const businessDb = env.MONGODB_DB ?? 'survey_system';
  if (prefix === businessDb) throw new Error('Test database prefix must not equal the business database');
  const mongodbUri = assertMongoUri(
    env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017', 'TEST_MONGODB_URI',
  );
  // MongoDB permits multi-host URIs; inspect only the database path, not host syntax.
  const path = mongodbUri.slice(mongodbUri.indexOf('://') + 3).split('?')[0];
  const slash = path.indexOf('/');
  const uriDb = slash < 0 ? '' : decodeURIComponent(path.slice(slash + 1));
  if (uriDb && (uriDb !== prefix || uriDb === businessDb)) {
    throw new Error('TEST_MONGODB_URI must have no database path or the matching dedicated test prefix');
  }
  const mongodbDb = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  if (mongodbDb === businessDb) throw new Error('Test database must not equal the business database');
  return Object.freeze({
    mongodbUri, mongodbDb, mongoTimeoutMS: 2000,
    nodeEnv: 'test', jsonLimit: '100kb',
    sessionSecret: randomUUID(), port: 0,
  });
}

export async function createTestDatabase(env = process.env) {
  const config = testDatabaseConfig(env);
  const ownedName = config.mongodbDb;
  const { db, client } = await connectDatabase(config);
  let cleaned = false;
  return {
    config, db, client,
    async cleanup() {
      if (cleaned) return;
      if (db.databaseName !== ownedName || !/^survey_test_/.test(ownedName)) {
        throw new Error('Refusing to clean a database not owned by this test');
      }
      try {
        await db.dropDatabase();
        cleaned = true;
      } finally {
        await client.close();
      }
    },
  };
}
