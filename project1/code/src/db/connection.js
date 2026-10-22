import { MongoClient } from 'mongodb';
import { assertDatabaseName, assertMongoUri } from '../config.js';
import { ensureIndexes } from './indexes.js';

export async function connectDatabase(config) {
  const uri = assertMongoUri(config?.mongodbUri);
  const name = assertDatabaseName(config?.mongodbDb);
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: config.mongoTimeoutMS ?? 5000,
  });
  try {
    await client.connect();
    const db = client.db(name);
    await db.command({ ping: 1 });
    await ensureIndexes(db);
    return { db, client };
  } catch (error) {
    await client.close();
    throw error;
  }
}
