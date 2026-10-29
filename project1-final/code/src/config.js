export function assertDatabaseName(value, field = 'MONGODB_DB') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(value)) {
    throw new Error(`${field} must contain 1-63 ASCII letters, digits, underscores or hyphens`);
  }
  if (['admin', 'local', 'config'].includes(value.toLowerCase())) {
    throw new Error(`${field} must not be a MongoDB system database`);
  }
  return value;
}

export function assertMongoUri(value, field = 'MONGODB_URI') {
  if (typeof value !== 'string' || !/^mongodb(?:\+srv)?:\/\/\S+$/.test(value)) {
    throw new Error(`${field} must be a MongoDB connection URI`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  for (const field of ['MONGODB_URI', 'MONGODB_DB', 'SESSION_SECRET']) {
    if (typeof env[field] !== 'string' || !env[field].trim()) {
      throw new Error(`Missing required configuration: ${field}`);
    }
  }
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test or production');
  }
  const portText = env.PORT ?? '3000';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  if (env.SESSION_SECRET.trim().length < 32 || env.SESSION_SECRET.includes('REPLACE_')) {
    throw new Error('SESSION_SECRET must be a non-placeholder secret of at least 32 characters');
  }
  return Object.freeze({
    port: Number(portText),
    nodeEnv,
    mongodbUri: assertMongoUri(env.MONGODB_URI),
    mongodbDb: assertDatabaseName(env.MONGODB_DB),
    sessionSecret: env.SESSION_SECRET,
    mongoTimeoutMS: 5000,
    jsonLimit: '100kb',
  });
}
