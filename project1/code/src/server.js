import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDatabase } from './db/connection.js';

export async function startServer(config = loadConfig()) {
  const { db, client } = await connectDatabase(config);
  const app = createApp({ db, client, config });
  let server;
  try {
    await app.locals.sessionStoreReady;
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(config.port, () => resolve(listener));
      listener.once('error', reject);
    });
  } catch (error) {
    try {
      await app.locals.sessionStore?.close();
    } finally {
      await client.close();
    }
    throw error;
  }
  let closing;
  function close() {
    closing ??= (async () => {
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeIdleConnections();
        });
      } finally {
        try {
          await app.locals.sessionStore?.close();
        } finally {
          await client.close();
        }
      }
    })();
    return closing;
  }
  return { app, server, db, client, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtime = await startServer();
    console.log(`Survey server listening on port ${runtime.server.address().port}`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        runtime.close().catch(() => {
          console.error('Server shutdown failed');
          process.exitCode = 1;
        });
      });
    }
  } catch (error) {
    // Never print driver errors: their messages can contain connection credentials.
    console.error(error.message.startsWith('Missing required configuration:')
      || /^(PORT|NODE_ENV|SESSION_SECRET|MONGODB_DB|MONGODB_URI) must/.test(error.message)
      ? error.message : 'Startup failed: MongoDB connection, index initialization or HTTP listen failed');
    process.exitCode = 1;
  }
}
