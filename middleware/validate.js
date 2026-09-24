import { MAX_SEARCH_LENGTH } from '../config.js';

// For router.param('id', parseId): route ids must be positive integers. Digits only, so "1e3",
// "0x10", "1.0" or "NaN" are refused too. The parsed id is left in req.id.
export function parseId(req, res, next, value) {
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  req.id = Number(value);
  next();
}

// The username (trimmed) and password from a signup or login body.
export function readCredentials(req) {
  return {
    username: String(req.body?.username ?? '').trim(),
    password: String(req.body?.password ?? ''),
  };
}

// The trimmed `body` of a post or comment, or undefined (after replying 400) if it's empty or
// longer than `maxLength`. `noun` ("Post", "Comment") is used in the error message.
export function validateBody(req, res, noun, maxLength) {
  const body = String(req.body?.body ?? '').trim();
  if (!body) res.status(400).json({ error: `${noun} cannot be empty` });
  else if (body.length > maxLength) res.status(400).json({ error: `${noun}s are limited to ${maxLength} characters` });
  else return body;
}

// The trimmed `q` query parameter, or undefined (after replying 400) if it's too long,
// since every search is a LIKE scan.
export function searchQuery(req, res) {
  const q = String(req.query.q ?? '').trim();
  if (q.length <= MAX_SEARCH_LENGTH) return q;
  res.status(400).json({ error: `Searches are limited to ${MAX_SEARCH_LENGTH} characters` });
}

// Middleware that reads the friend action's `intent` (from the body or the query string) into
// req.intent, replying 400 unless it's one of `allowed` (or missing, when `optional`).
export function requireIntent(allowed, { optional = false } = {}) {
  const quoted = allowed.map((intent) => `'${intent}'`);
  const error = `intent must be ${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`;
  return (req, res, next) => {
    const intent = String(req.body?.intent ?? req.query.intent ?? '');
    if (!allowed.includes(intent) && !(optional && !intent)) return res.status(400).json({ error });
    req.intent = intent;
    next();
  };
}
