export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let normalized = error;
  if (error.type === 'entity.parse.failed') {
    normalized = new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  } else if (error.type === 'entity.too.large') {
    normalized = new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit');
  } else if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
    normalized = new HttpError(415, 'UNSUPPORTED_ENCODING', 'Request encoding is not supported');
  }
  if (!(normalized instanceof HttpError) || normalized.status >= 500) {
    const unavailable = normalized instanceof HttpError && normalized.status === 503;
    return res.status(unavailable ? 503 : 500).json({
      error: {
        code: unavailable ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR',
        message: unavailable ? 'Database is unavailable' : 'Internal server error',
      },
    });
  }
  const body = { code: normalized.code, message: normalized.message };
  if (normalized.details !== undefined) body.details = normalized.details;
  return res.status(normalized.status).json({ error: body });
}

export function sendData(res, data, status = 200) {
  return res.status(status).json({ data });
}
