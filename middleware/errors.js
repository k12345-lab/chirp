// Any /api path that no route matched.
export function apiNotFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Final error handler: always reply with JSON, never with Express's HTML page or a stack trace.
// Covers malformed or oversized JSON bodies and unexpected (e.g. SQL) errors.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  let error = status < 500 ? 'Bad request' : 'Something went wrong. Please try again.';
  if (err.type === 'entity.parse.failed') error = 'Request body is not valid JSON';
  else if (err.type === 'entity.too.large') error = 'Request body is too large';
  else if (status < 500 && err.expose) error = err.message;
  if (status >= 500) console.error(err);
  res.status(status).json({ error });
}
