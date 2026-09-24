import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { db, checkpoint, FRIENDSHIP_STATUS as STATUS } from './db.js';
import { COMMON_PASSWORDS } from './common-passwords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SESSION_IDLE_MS = 14 * DAY; // A session expires after 14 days without use...
const SESSION_MAX_MS = 90 * DAY; // ...and 90 days after login, however often it's used.
const SESSION_REFRESH_MS = DAY; // Slide the expiry forward at most once a day.
const MAX_POST_LENGTH = 280;
const MAX_COMMENT_LENGTH = 280;
const MAX_SEARCH_LENGTH = 100;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 20;
// Without anchors, so the frontend can use it as an <input pattern> (which is implicitly anchored).
const USERNAME_PATTERN = `[a-zA-Z0-9_]{${MIN_USERNAME_LENGTH},${MAX_USERNAME_LENGTH}}`;
const USERNAME_RE = new RegExp(`^${USERNAME_PATTERN}$`);
const JSON_BODY_LIMIT = '10kb';
const POSTS_PAGE_SIZE = 50;
const USERS_PAGE_SIZE = 10;
// Searches that can list strangers must give at least this many leading characters of a username.
const MIN_USER_SEARCH_LENGTH = 3;
// After someone declines your friend request, you can't ask them again for this long.
const DECLINE_COOLDOWN_DAYS = 30;
const DECLINE_COOLDOWN_MS = DECLINE_COOLDOWN_DAYS * DAY;
// Session cookies are Secure unless COOKIE_SECURE=false; see sessionCookie().
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const SESSION_COOKIE = '__Host-sid';
const DEV_SESSION_COOKIE = 'sid'; // Plain-HTTP localhost only; the __Host- prefix requires Secure.
const SESSION_TOKEN_BYTES = 32;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// How the current user relates to another user; see getRelation(). Sent to the client as `relation`.
const RELATION = Object.freeze({
  SELF: 'self',
  FRIENDS: 'friends',
  OUTGOING: 'outgoing', // You asked them.
  INCOMING: 'incoming', // They asked you.
  DECLINED: 'declined', // They declined your request recently.
  BLOCKED: 'blocked', // You blocked them.
  BLOCKED_BY: 'blocked-by', // They blocked you. Never sent to the client.
  NONE: 'none',
});

const nowIso = () => new Date().toISOString();

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy, set TRUST_PROXY (e.g. "1" or "loopback") so req.ip, req.secure and the
// rate limits use the real client address and protocol.
if (process.env.TRUST_PROXY) {
  const trust = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust === 'true' || trust);
}
app.use(helmet({
  // The frontend is one HTML file plus same-origin app.js and style.css, with no inline scripts,
  // inline styles or third-party resources, so everything else can be refused.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  xFrameOptions: { action: 'deny' }, // Matches frame-ancestors 'none' for older browsers.
}));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth helpers ----------

const scrypt = promisify(crypto.scrypt);
// N=2^17, r=8 needs 128 MiB per hash (128 * N * r bytes), above Node's 32 MiB default maxmem.
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 };
// Hashes from before the parameters were stored ("salt:hash") used Node's defaults.
const LEGACY_SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1 };
const SCRYPT_KEY_LENGTH = 64; // Bytes.
const SCRYPT_SALT_LENGTH = 16; // Bytes.
const HEX_RE = /^(?:[0-9a-f]{2})+$/i;

function deriveKey(password, salt, { N, r, p }, keylen) {
  return scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r });
}

// Stored as "scrypt$N$r$p$<salt hex>$<hash hex>" so the cost can be raised later.
async function hashPassword(password) {
  const { N, r, p } = SCRYPT_PARAMS;
  const salt = crypto.randomBytes(SCRYPT_SALT_LENGTH);
  const hash = await deriveKey(password, salt, SCRYPT_PARAMS, SCRYPT_KEY_LENGTH);
  return ['scrypt', N, r, p, salt.toString('hex'), hash.toString('hex')].join('$');
}

// Returns { params, salt, hash } for either stored format, or null if the value is malformed
// (or asks for an unreasonable cost, so a bad row can't make us allocate gigabytes).
function parsePasswordHash(stored) {
  const text = String(stored ?? '');
  let params, saltHex, hashHex;
  if (text.startsWith('scrypt$')) {
    const parts = text.split('$');
    if (parts.length !== 6) return null;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    params = { N, r, p };
    [saltHex, hashHex] = parts.slice(4);
  } else {
    params = LEGACY_SCRYPT_PARAMS;
    [saltHex, hashHex] = text.split(':');
  }
  const { N, r, p } = params;
  const validCost = Number.isInteger(Math.log2(N)) && N >= 2 && N <= 2 ** 20
    && Number.isInteger(r) && r >= 1 && r <= 32 && Number.isInteger(p) && p >= 1 && p <= 16;
  if (!validCost || !HEX_RE.test(saltHex ?? '') || !HEX_RE.test(hashHex ?? '')) return null;
  return { params, salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
}

// Never throws: a malformed stored hash just fails to match.
async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  try {
    const hash = await deriveKey(password, parsed.salt, parsed.params, parsed.hash.length);
    return crypto.timingSafeEqual(hash, parsed.hash);
  } catch {
    return false;
  }
}

function needsRehash(stored) {
  const { N, r, p } = parsePasswordHash(stored)?.params ?? {};
  return N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p;
}

// Login checks unknown usernames against this, so they take as long as wrong passwords.
const DUMMY_PASSWORD_HASH = await hashPassword(crypto.randomBytes(SCRYPT_SALT_LENGTH).toString('hex'));

function passwordProblem(password, username) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const lower = password.toLowerCase();
  if (lower === username.toLowerCase()) return "Password can't be the same as your username";
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common. Please choose another.';
  return null;
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return null; // Malformed percent-encoding: treat as no cookie rather than failing the request.
    }
  }
  return null;
}

// The session cookie is SESSION_COOKIE ("__Host-sid"): Secure, host-only and path=/, so it never
// travels over plain HTTP and can't be set by a subdomain. Plain-HTTP requests to localhost (local
// dev) and COOKIE_SECURE=false use DEV_SESSION_COOKIE ("sid") instead, since that prefix requires
// Secure. Returns the cookie's name and the options for setting or clearing it.
function sessionCookie(req) {
  const secure = COOKIE_SECURE && (req.secure || !LOOPBACK_HOSTS.has(req.hostname));
  return {
    name: secure ? SESSION_COOKIE : DEV_SESSION_COOKIE,
    options: { httpOnly: true, sameSite: 'strict', secure, path: '/' },
  };
}

function setSessionCookie(req, res, token, maxAge) {
  const { name, options } = sessionCookie(req);
  res.cookie(name, token, { ...options, maxAge });
}

function clearSessionCookie(req, res) {
  const { name, options } = sessionCookie(req);
  res.clearCookie(name, options);
}

const sessionToken = (req) => getCookie(req, sessionCookie(req).name);

// Only a SHA-256 of the token is stored, so a leaked database can't be used to log in.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function startSession(req, res, userId) {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now + SESSION_IDLE_MS);
  setSessionCookie(req, res, token, SESSION_IDLE_MS);
}

// Attach req.user on every API request if the session cookie is valid, and slide its expiry.
app.use('/api', (req, res, next) => {
  const token = sessionToken(req);
  if (!token) return next();
  const now = Date.now();
  const tokenHash = hashToken(token);
  const session = db.prepare(`
    SELECT u.id, u.username, s.created_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, now);
  if (!session) return next();
  req.user = { id: session.id, username: session.username };
  const expiresAt = Math.min(now + SESSION_IDLE_MS, session.created_at + SESSION_MAX_MS);
  if (expiresAt - session.expires_at > SESSION_REFRESH_MS) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash);
    setSessionCookie(req, res, token, expiresAt - now);
  }
  next();
});

// CSRF defence in depth (on top of SameSite=Strict). Browsers send Origin on cross-site requests
// and on same-origin POST/DELETE, so a data-changing /api request from another site is refused.
// Requests with neither Origin nor Sec-Fetch-Site come from non-browser clients such as curl,
// which can't ride on a victim's cookies, so they're allowed.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null; // e.g. "null" from a sandboxed frame.
  }
}
app.use('/api', (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  const sameOrigin = origin
    ? hostOf(origin) === String(req.get('host') ?? '').toLowerCase()
    : !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
  if (!sameOrigin) return res.status(403).json({ error: 'Cross-origin request refused' });
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ---------- Rate limits ----------

// In-memory counters (reset on restart), which is fine for a single small server.
function limiter(windowMs, limit, what, options = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: `Too many ${what}. Please wait a while and try again.` },
    ...options,
  });
}
const byUser = (req) => `user:${req.user.id}`;
const signupLimiter = limiter(HOUR, 10, 'sign-ups from your network');
// Only failed logins count. The per-username limit stops guessing one account's password from many
// addresses; the per-IP limit stops one address from trying many accounts.
const loginIpLimiter = limiter(15 * MINUTE, 30, 'failed logins from your network', { skipSuccessfulRequests: true });
const loginUserLimiter = limiter(15 * MINUTE, 10, 'failed logins for this account', {
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `username:${readCredentials(req).username.toLowerCase()}`,
});
const postLimiter = limiter(15 * MINUTE, 30, 'posts', { keyGenerator: byUser });
const commentLimiter = limiter(15 * MINUTE, 60, 'comments', { keyGenerator: byUser });
const friendLimiter = limiter(HOUR, 50, 'friend requests', { keyGenerator: byUser });
const blockLimiter = limiter(HOUR, 50, 'blocks', { keyGenerator: byUser });
// Searching and looking up usernames reveal who has an account, so they're limited too. Only
// lookups of names that don't exist (404) count, so browsing friends' profiles is unaffected.
const userSearchLimiter = limiter(15 * MINUTE, 120, 'user searches', { keyGenerator: byUser });
const userLookupLimiter = limiter(15 * MINUTE, 60, 'lookups of unknown users', {
  keyGenerator: byUser,
  skipSuccessfulRequests: true,
});
const deleteAccountLimiter = limiter(15 * MINUTE, 5, 'failed attempts to delete your account', {
  keyGenerator: byUser,
  skipSuccessfulRequests: true,
});
const exportLimiter = limiter(HOUR, 10, 'data exports', { keyGenerator: byUser });

// ---------- Input validation ----------

// Route ids must be positive integers. Digits only, so "1e3", "0x10", "1.0" or "NaN" are refused
// too. The parsed id is left in req.id.
app.param('id', (req, res, next, value) => {
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  req.id = Number(value);
  next();
});

// The username (trimmed) and password from a signup or login body.
function readCredentials(req) {
  return {
    username: String(req.body?.username ?? '').trim(),
    password: String(req.body?.password ?? ''),
  };
}

// The trimmed `body` of a post or comment, or undefined (after replying 400) if it's empty or
// longer than `maxLength`. `noun` ("Post", "Comment") is used in the error message.
function validateBody(req, res, noun, maxLength) {
  const body = String(req.body?.body ?? '').trim();
  if (!body) res.status(400).json({ error: `${noun} cannot be empty` });
  else if (body.length > maxLength) res.status(400).json({ error: `${noun}s are limited to ${maxLength} characters` });
  else return body;
}

// The trimmed `q` query parameter, or undefined (after replying 400) if it's too long,
// since every search is a LIKE '%…%' scan.
function searchQuery(req, res) {
  const q = String(req.query.q ?? '').trim();
  if (q.length <= MAX_SEARCH_LENGTH) return q;
  res.status(400).json({ error: `Searches are limited to ${MAX_SEARCH_LENGTH} characters` });
}

// Middleware that reads the friend action's `intent` (from the body or the query string) into
// req.intent, replying 400 unless it's one of `allowed` (or missing, when `optional`).
function requireIntent(allowed, { optional = false } = {}) {
  const quoted = allowed.map((intent) => `'${intent}'`);
  const error = `intent must be ${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`;
  return (req, res, next) => {
    const intent = String(req.body?.intent ?? req.query.intent ?? '');
    if (!allowed.includes(intent) && !(optional && !intent)) return res.status(400).json({ error });
    req.intent = intent;
    next();
  };
}

// ---------- Friendship helpers ----------

// SQL condition: the friendships row (alias prefix `f`, e.g. 'f.') is between users `a` and `b`,
// whichever of them sent it.
const eitherDirectionSql = (a, b, f = '') =>
  `((${f}requester_id = ${a} AND ${f}addressee_id = ${b}) OR (${f}requester_id = ${b} AND ${f}addressee_id = ${a}))`;

// SQL condition: the friendships row involves $me, in either role.
const involvesMeSql = (f = '') => `(${f}requester_id = $me OR ${f}addressee_id = $me)`;

// SQL expression: the id of the user at the other end of a friendships row from $me.
const otherUserSql = (f = '') => `CASE WHEN ${f}requester_id = $me THEN ${f}addressee_id ELSE ${f}requester_id END`;

// Subquery that yields the ids of everyone who is an accepted friend of $me.
const FRIEND_IDS_SQL = `
  SELECT ${otherUserSql()}
  FROM friendships
  WHERE status = '${STATUS.ACCEPTED}' AND ${involvesMeSql()}
`;

// A comment is shown to its author, the post's owner, and the commenter's accepted friends
// (so never to someone the commenter isn't friends with). Needs aliases c (comment), p (post).
const COMMENT_VISIBLE_SQL = `(c.user_id = $me OR p.user_id = $me OR c.user_id IN (${FRIEND_IDS_SQL}))`;

// A declined request stops the requester from asking again until this ISO time has passed.
const declinedSince = () => new Date(Date.now() - DECLINE_COOLDOWN_MS).toISOString();

// Relationship of $me to user alias u, given the friendship row alias f (LEFT JOINed). Must match
// getRelation() below.
const RELATION_SQL = `
  CASE
    WHEN f.status IS NULL THEN '${RELATION.NONE}'
    WHEN f.status = '${STATUS.ACCEPTED}' THEN '${RELATION.FRIENDS}'
    WHEN f.status = '${STATUS.PENDING}'
      THEN CASE WHEN f.requester_id = $me THEN '${RELATION.OUTGOING}' ELSE '${RELATION.INCOMING}' END
    WHEN f.status = '${STATUS.BLOCKED}'
      THEN CASE WHEN f.requester_id = $me THEN '${RELATION.BLOCKED}' ELSE '${RELATION.BLOCKED_BY}' END
    WHEN f.requester_id = $me AND f.responded_at > $declinedSince THEN '${RELATION.DECLINED}'
    ELSE '${RELATION.NONE}'
  END
`;

// Returns one of RELATION. Someone who declined a request sees NONE and may send a request
// themselves. BLOCKED_BY is never sent to the client: routes answer as if the user didn't exist.
function getRelation(meId, otherId) {
  if (meId === otherId) return RELATION.SELF;
  const row = db.prepare(`
    SELECT requester_id, status, responded_at FROM friendships WHERE ${eitherDirectionSql('$a', '$b')}
  `).get({ a: meId, b: otherId });
  if (!row) return RELATION.NONE;
  const mine = row.requester_id === meId;
  switch (row.status) {
    case STATUS.ACCEPTED: return RELATION.FRIENDS;
    case STATUS.PENDING: return mine ? RELATION.OUTGOING : RELATION.INCOMING;
    case STATUS.BLOCKED: return mine ? RELATION.BLOCKED : RELATION.BLOCKED_BY;
    default: return mine && row.responded_at > declinedSince() ? RELATION.DECLINED : RELATION.NONE;
  }
}

// Run `fn` inside a transaction.
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Remove whatever row exists between two users (both directions).
function deleteFriendship(aId, bId) {
  db.prepare(`DELETE FROM friendships WHERE ${eitherDirectionSql('$a', '$b')}`).run({ a: aId, b: bId });
}

// Replace whatever row exists between two users with a new one from `requesterId` in `status`.
function replaceFriendship(requesterId, addresseeId, status) {
  transaction(() => {
    deleteFriendship(requesterId, addresseeId);
    db.prepare('INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?)')
      .run(requesterId, addresseeId, status, nowIso());
  });
}

// Accept or decline the pending request from `requesterId` to `addresseeId`.
function respondToRequest(requesterId, addresseeId, status) {
  db.prepare('UPDATE friendships SET status = ?, responded_at = ? WHERE requester_id = ? AND addressee_id = ?')
    .run(status, nowIso(), requesterId, addresseeId);
}

function findUser(username) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE username = ?').get(username);
}

// Middleware for /:username routes, after requireAuth and any rate limiter: sets
// req.other = { user, relationship }, or replies 404 if there's no such user or they blocked you,
// so a block looks the same as a missing account. (Not app.param: param callbacks run before the
// route's requireAuth and rate limiters, and userLookupLimiter has to see these 404s.)
function loadVisibleUser(req, res, next) {
  const user = findUser(req.params.username);
  const relationship = user && getRelation(req.user.id, user.id);
  if (!user || relationship === RELATION.BLOCKED_BY) return res.status(404).json({ error: 'User not found' });
  req.other = { user, relationship };
  next();
}

// ---------- Post helpers ----------

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => '\\' + c);
}

// Cursors for post lists are "<created_at>~<id>" of the last post on the previous page.
function parsePostCursor(cursor) {
  const text = String(cursor ?? '');
  const sep = text.lastIndexOf('~');
  const id = Number(text.slice(sep + 1));
  if (sep < 1 || !Number.isInteger(id)) return null;
  return { createdAt: text.slice(0, sep), id };
}

const formatPost = (meId) => (p) => ({
  id: p.id,
  body: p.body,
  createdAt: p.created_at,
  username: p.username,
  likeCount: p.like_count,
  liked: Boolean(p.liked),
  commentCount: p.comment_count,
  mine: p.user_id === meId,
});

// One page of posts visible to `meId`: their own plus accepted friends', newest first.
// Optionally restricted to one author and/or filtered by a search term.
// Returns { posts, nextCursor }; nextCursor is null on the last page.
function visiblePosts(meId, { authorId = null, search = null, cursor = null } = {}) {
  const q = search ? `%${escapeLike(search)}%` : null;
  const after = parsePostCursor(cursor);
  const rows = db.prepare(`
    SELECT p.id, p.user_id, p.body, p.created_at, u.username,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $me) AS liked,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND ${COMMENT_VISIBLE_SQL}) AS comment_count
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE (p.user_id = $me OR p.user_id IN (${FRIEND_IDS_SQL}))
      AND ($author IS NULL OR p.user_id = $author)
      AND ($q IS NULL OR p.body LIKE $q ESCAPE '\\' OR u.username LIKE $q ESCAPE '\\')
      AND ($afterId IS NULL OR p.created_at < $afterAt OR (p.created_at = $afterAt AND p.id < $afterId))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT $limit
  `).all({
    me: meId,
    author: authorId,
    q,
    afterAt: after?.createdAt ?? null,
    afterId: after?.id ?? null,
    limit: POSTS_PAGE_SIZE + 1,
  });
  const hasMore = rows.length > POSTS_PAGE_SIZE;
  const page = rows.slice(0, POSTS_PAGE_SIZE);
  const last = page.at(-1);
  return {
    posts: page.map(formatPost(meId)),
    nextCursor: hasMore ? `${last.created_at}~${last.id}` : null,
  };
}

function isPostVisible(meId, postId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM posts WHERE id = $post AND (user_id = $me OR user_id IN (${FRIEND_IDS_SQL}))
  `).get({ post: postId, me: meId }));
}

// Middleware for /api/posts/:id/... routes, after requireAuth: 404 unless you can see the post.
function requireVisiblePost(req, res, next) {
  if (!isPostVisible(req.user.id, req.id)) return res.status(404).json({ error: 'Post not found' });
  next();
}

// ---------- Config ----------

// Limits and names the frontend shares with the server, so they're defined only here.
// BLOCKED_BY is left out: the client never sees it.
const { BLOCKED_BY, ...CLIENT_RELATION } = RELATION;
const CLIENT_CONFIG = Object.freeze({
  maxPostLength: MAX_POST_LENGTH,
  maxCommentLength: MAX_COMMENT_LENGTH,
  maxSearchLength: MAX_SEARCH_LENGTH,
  minUserSearchLength: MIN_USER_SEARCH_LENGTH,
  minUsernameLength: MIN_USERNAME_LENGTH,
  maxUsernameLength: MAX_USERNAME_LENGTH,
  usernamePattern: USERNAME_PATTERN,
  minPasswordLength: MIN_PASSWORD_LENGTH,
  maxPasswordLength: MAX_PASSWORD_LENGTH,
  declineCooldownDays: DECLINE_COOLDOWN_DAYS,
  relation: CLIENT_RELATION,
});

app.get('/api/config', (req, res) => {
  res.json(CLIENT_CONFIG);
});

// ---------- Auth routes ----------

const SQLITE_CONSTRAINT_UNIQUE = 2067;

app.post('/api/signup', signupLimiter, async (req, res) => {
  const { username, password } = readCredentials(req);
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: `Username must be ${MIN_USERNAME_LENGTH}–${MAX_USERNAME_LENGTH} letters, numbers, or underscores`,
    });
  }
  const problem = passwordProblem(password, username);
  if (problem) return res.status(400).json({ error: problem });
  if (findUser(username)) {
    return res.status(409).json({ error: 'That username is taken' });
  }
  const passwordHash = await hashPassword(password);
  let userId;
  try {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
    ).run(username, passwordHash, nowIso());
    userId = Number(lastInsertRowid);
  } catch (err) {
    // Someone else took the name while we were hashing.
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) return res.status(409).json({ error: 'That username is taken' });
    throw err;
  }
  startSession(req, res, userId);
  res.status(201).json({ username });
});

app.post('/api/login', loginIpLimiter, loginUserLimiter, async (req, res) => {
  const { username, password } = readCredentials(req);
  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  // Always run scrypt, even for unknown usernames, so response time doesn't reveal which exist.
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  // Upgrade hashes made with older (cheaper) scrypt parameters.
  if (needsRehash(user.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  }
  startSession(req, res, user.id);
  res.json({ username: user.username });
});

app.post('/api/logout', (req, res) => {
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Ends every session of the current user, on all devices.
app.post('/api/logout-all', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const { pending } = db.prepare(
    'SELECT COUNT(*) AS pending FROM friendships WHERE addressee_id = ? AND status = ?'
  ).get(req.user.id, STATUS.PENDING);
  res.json({ username: req.user.username, pendingRequests: pending });
});

// Delete your account. Body: { password }. Everything else you created (sessions, posts and the
// comments and likes on them, your comments, likes and friendships) goes with it via ON DELETE
// CASCADE, and secure_delete plus a checkpoint make sure the text doesn't linger in the file.
app.delete('/api/me', requireAuth, deleteAccountLimiter, async (req, res) => {
  const password = String(req.body?.password ?? '');
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  // 403 rather than 401, which would mean "not logged in".
  if (!(await verifyPassword(password, password_hash))) {
    return res.status(403).json({ error: 'Incorrect password' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  checkpoint();
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Download everything Chirp stores about you, as JSON. Comments other people wrote on your
// posts are theirs, so they aren't included (only their count).
app.get('/api/me/export', requireAuth, exportLimiter, (req, res) => {
  const me = req.user.id;
  const user = db.prepare('SELECT username, created_at FROM users WHERE id = ?').get(me);
  const posts = db.prepare(`
    SELECT p.id, p.body, p.created_at,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p WHERE p.user_id = ? ORDER BY p.created_at, p.id
  `).all(me);
  const comments = db.prepare(`
    SELECT c.id, c.post_id, u.username AS post_author, c.body, c.created_at
    FROM comments c JOIN posts p ON p.id = c.post_id JOIN users u ON u.id = p.user_id
    WHERE c.user_id = ? ORDER BY c.created_at, c.id
  `).all(me);
  const likes = db.prepare(`
    SELECT l.post_id, u.username AS post_author
    FROM likes l JOIN posts p ON p.id = l.post_id JOIN users u ON u.id = p.user_id
    WHERE l.user_id = ? ORDER BY l.post_id
  `).all(me);
  // Leave out other people's blocks of you: those are their data, not yours.
  const friendships = db.prepare(`
    SELECT u.username, f.requester_id, f.status, f.created_at, f.responded_at
    FROM friendships f
    JOIN users u ON u.id = ${otherUserSql('f.')}
    WHERE ${involvesMeSql('f.')} AND NOT (f.status = '${STATUS.BLOCKED}' AND f.addressee_id = $me)
    ORDER BY u.username COLLATE NOCASE
  `).all({ me });

  const exportedAt = nowIso();
  res.attachment(`chirp-${user.username}-${exportedAt.slice(0, 10)}.json`);
  res.json({
    exportedAt,
    account: { username: user.username, joined: user.created_at },
    posts: posts.map((p) => ({
      id: p.id, body: p.body, createdAt: p.created_at, likeCount: p.like_count, commentCount: p.comment_count,
    })),
    comments: comments.map((c) => ({
      id: c.id, postId: c.post_id, postAuthor: c.post_author, body: c.body, createdAt: c.created_at,
    })),
    likes: likes.map((l) => ({ postId: l.post_id, postAuthor: l.post_author })),
    friendships: friendships.map((f) => ({
      username: f.username,
      status: f.status,
      direction: f.requester_id === me ? 'sent' : 'received',
      createdAt: f.created_at,
      respondedAt: f.responded_at,
    })),
  });
});

// ---------- Post routes ----------

app.get('/api/feed', requireAuth, (req, res) => {
  const search = searchQuery(req, res);
  if (search === undefined) return;
  res.json(visiblePosts(req.user.id, { search: search || null, cursor: req.query.cursor }));
});

app.post('/api/posts', requireAuth, postLimiter, (req, res) => {
  const body = validateBody(req, res, 'Post', MAX_POST_LENGTH);
  if (body === undefined) return;
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO posts (user_id, body, created_at) VALUES (?, ?, ?)'
  ).run(req.user.id, body, nowIso());
  res.status(201).json({ id: Number(lastInsertRowid) });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const { changes } = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.id, req.user.id);
  if (!changes) return res.status(404).json({ error: 'Post not found' });
  res.json({ ok: true });
});

// Both like routes reply with the post's current state so every client shows the server's truth.
function likeState(meId, postId) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM likes WHERE post_id = $post) AS like_count,
      EXISTS (SELECT 1 FROM likes WHERE post_id = $post AND user_id = $me) AS liked
  `).get({ post: postId, me: meId });
  return { liked: Boolean(row.liked), likeCount: row.like_count };
}

app.post('/api/posts/:id/like', requireAuth, requireVisiblePost, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, req.id);
  res.json(likeState(req.user.id, req.id));
});

app.delete('/api/posts/:id/like', requireAuth, requireVisiblePost, (req, res) => {
  db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, req.id);
  res.json(likeState(req.user.id, req.id));
});

// ---------- Comment routes ----------

// Comments on a post, oldest first. Only those you may see (COMMENT_VISIBLE_SQL) are returned:
// yours, all of them on your own posts, and otherwise only those by your friends.
app.get('/api/posts/:id/comments', requireAuth, requireVisiblePost, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.user_id, c.body, c.created_at, u.username, p.user_id AS post_owner_id
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN posts p ON p.id = c.post_id
    WHERE c.post_id = $post AND ${COMMENT_VISIBLE_SQL}
    ORDER BY c.created_at, c.id
  `).all({ post: req.id, me: req.user.id });
  res.json(rows.map((c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    username: c.username,
    // The comment's author or the post's owner may delete it.
    canDelete: c.user_id === req.user.id || c.post_owner_id === req.user.id,
  })));
});

app.post('/api/posts/:id/comments', requireAuth, commentLimiter, requireVisiblePost, (req, res) => {
  const body = validateBody(req, res, 'Comment', MAX_COMMENT_LENGTH);
  if (body === undefined) return;
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'
  ).run(req.id, req.user.id, body, nowIso());
  res.status(201).json({ id: Number(lastInsertRowid) });
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const { changes } = db.prepare(`
    DELETE FROM comments
    WHERE id = $id AND (user_id = $me OR post_id IN (SELECT id FROM posts WHERE user_id = $me))
  `).run({ id: req.id, me: req.user.id });
  if (!changes) return res.status(404).json({ error: 'Comment not found' });
  res.json({ ok: true });
});

// ---------- User & friend routes ----------

// One page of other users whose username starts with `q`, alphabetically. `relation` (optional)
// filters in SQL, before the page limit, so e.g. "Find people" isn't starved by friends. `cursor`
// is the last username seen. To keep the user list from being walked, a search that can return
// strangers (no relation filter, or 'none') needs at least MIN_USER_SEARCH_LENGTH characters.
// People who blocked you are never listed.
const USER_RELATION_FILTERS = [
  RELATION.NONE, RELATION.FRIENDS, RELATION.OUTGOING, RELATION.INCOMING, RELATION.DECLINED, RELATION.BLOCKED,
];
app.get('/api/users', requireAuth, userSearchLimiter, (req, res) => {
  const q = searchQuery(req, res);
  if (q === undefined) return;
  const relationFilter = req.query.relation ? String(req.query.relation) : null;
  if (relationFilter && !USER_RELATION_FILTERS.includes(relationFilter)) {
    return res.status(400).json({ error: 'Unknown relation filter' });
  }
  if ((!relationFilter || relationFilter === RELATION.NONE) && q.length < MIN_USER_SEARCH_LENGTH) {
    return res.status(400).json({ error: `Type at least ${MIN_USER_SEARCH_LENGTH} characters of a username` });
  }
  const rows = db.prepare(`
    SELECT username, relation FROM (
      SELECT u.username, ${RELATION_SQL} AS relation
      FROM users u
      LEFT JOIN friendships f ON ${eitherDirectionSql('$me', 'u.id', 'f.')}
      WHERE u.id != $me AND u.username LIKE $q ESCAPE '\\'
        AND ($after IS NULL OR u.username > $after)
    )
    WHERE relation != '${RELATION.BLOCKED_BY}' AND ($relation IS NULL OR relation = $relation)
    ORDER BY username COLLATE NOCASE
    LIMIT $limit
  `).all({
    me: req.user.id,
    q: `${escapeLike(q)}%`,
    after: req.query.cursor ? String(req.query.cursor) : null,
    declinedSince: declinedSince(),
    relation: relationFilter,
    limit: USERS_PAGE_SIZE + 1,
  });
  const hasMore = rows.length > USERS_PAGE_SIZE;
  const users = rows.slice(0, USERS_PAGE_SIZE);
  res.json({ users, nextCursor: hasMore ? users.at(-1).username : null });
});

// Profile plus one page of posts. Pass `cursor` (the previous nextCursor) for later pages.
// `joined` is the month you signed up ("YYYY-MM"), shown only to yourself and friends (else null).
app.get('/api/users/:username', requireAuth, userLookupLimiter, loadVisibleUser, (req, res) => {
  const { user, relationship } = req.other;
  const canSee = relationship === RELATION.SELF || relationship === RELATION.FRIENDS;
  const page = canSee ? visiblePosts(req.user.id, { authorId: user.id, cursor: req.query.cursor }) : null;
  res.json({
    username: user.username,
    joined: canSee ? user.created_at.slice(0, 7) : null,
    relation: relationship,
    posts: page ? page.posts : null,
    nextCursor: page ? page.nextCursor : null,
  });
});

// Your friends, requests in both directions, and the people you've blocked. Requests you declined
// and requests of yours that were declined are left out (a profile shows the latter).
app.get('/api/friends', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT f.requester_id, f.status, u.username
    FROM friendships f
    JOIN users u ON u.id = ${otherUserSql('f.')}
    WHERE ${involvesMeSql('f.')}
    ORDER BY u.username COLLATE NOCASE
  `).all({ me: req.user.id });
  const result = { friends: [], incoming: [], outgoing: [], blocked: [] };
  for (const r of rows) {
    const mine = r.requester_id === req.user.id;
    if (r.status === STATUS.ACCEPTED) result.friends.push(r.username);
    else if (r.status === STATUS.PENDING) result[mine ? 'outgoing' : 'incoming'].push(r.username);
    else if (r.status === STATUS.BLOCKED && mine) result.blocked.push(r.username);
  }
  res.json(result);
});

// Body: { intent: 'request' | 'accept' }.
// - request: 201 if a new request was created; 200 if they had already asked you (it's accepted);
//   409 if you're already friends, already asked them, they declined you within the cooldown,
//   or you blocked them.
// - accept: 200 if their pending request was accepted; 409 if there is no request to accept
//   (e.g. they canceled it), so a stale "Accept" button never sends a new request.
// 404 if the user doesn't exist or has blocked you.
app.post('/api/friends/:username', requireAuth, friendLimiter, requireIntent(['request', 'accept']), loadVisibleUser,
  (req, res) => {
    const { user: other, relationship } = req.other;
    if (relationship === RELATION.SELF) return res.status(400).json({ error: "You can't friend yourself" });

    if (relationship === RELATION.INCOMING) {
      respondToRequest(other.id, req.user.id, STATUS.ACCEPTED);
      return res.json({ relation: RELATION.FRIENDS, result: 'accepted' });
    }
    if (req.intent === 'accept') {
      return res.status(409).json({ error: `@${other.username} has no pending request to accept`, relation: relationship });
    }
    if (relationship === RELATION.NONE) {
      // Replaces any old declined request between you (in either direction).
      replaceFriendship(req.user.id, other.id, STATUS.PENDING);
      return res.status(201).json({ relation: RELATION.OUTGOING, result: 'created' });
    }
    const error = {
      [RELATION.FRIENDS]: `You're already friends with @${other.username}`,
      [RELATION.OUTGOING]: 'Friend request already sent',
      [RELATION.DECLINED]: `@${other.username} declined your friend request. You can't send another one yet.`,
      [RELATION.BLOCKED]: `You've blocked @${other.username}. Unblock them first.`,
    }[relationship];
    res.status(409).json({ error, relation: relationship });
  });

// Cancel your request, decline theirs, or unfriend. Optional body
// { intent: 'cancel' | 'decline' | 'unfriend' } makes the request fail with 409 unless the relation
// still matches (so a stale "Cancel request" button can't unfriend someone who has since accepted).
// Declining keeps the row as 'declined', so the requester can't ask again straight away; the other
// two delete it. 404 if there was nothing to remove. Blocks are removed with DELETE /api/blocks.
const DELETE_INTENTS = { cancel: RELATION.OUTGOING, decline: RELATION.INCOMING, unfriend: RELATION.FRIENDS };
app.delete('/api/friends/:username', requireAuth, requireIntent(Object.keys(DELETE_INTENTS), { optional: true }),
  loadVisibleUser, (req, res) => {
    const { user: other, relationship } = req.other;
    if (relationship === RELATION.SELF) return res.status(400).json({ error: "You can't unfriend yourself" });
    if (relationship === RELATION.NONE || relationship === RELATION.DECLINED) {
      return res.status(404).json({ error: 'No friendship or request to remove', relation: relationship });
    }
    if (relationship === RELATION.BLOCKED || (req.intent && DELETE_INTENTS[req.intent] !== relationship)) {
      return res.status(409).json({ error: 'That friendship has changed. Refresh and try again.', relation: relationship });
    }
    if (relationship === RELATION.INCOMING) {
      respondToRequest(other.id, req.user.id, STATUS.DECLINED);
      return res.json({ relation: RELATION.NONE, result: 'declined' });
    }
    deleteFriendship(req.user.id, other.id);
    res.json({ relation: RELATION.NONE, result: 'removed' });
  });

// Block a user: ends any friendship or request between you, and from then on they can't see your
// profile, find you in searches or send you requests (to them it looks like you don't exist).
// 201 when blocked, 200 if you had already blocked them.
app.post('/api/blocks/:username', requireAuth, blockLimiter, loadVisibleUser, (req, res) => {
  const { user: other, relationship } = req.other;
  if (relationship === RELATION.SELF) return res.status(400).json({ error: "You can't block yourself" });
  if (relationship === RELATION.BLOCKED) return res.json({ relation: RELATION.BLOCKED, result: 'unchanged' });
  replaceFriendship(req.user.id, other.id, STATUS.BLOCKED);
  res.status(201).json({ relation: RELATION.BLOCKED, result: 'blocked' });
});

// Unblock a user. 404 if you hadn't blocked them.
app.delete('/api/blocks/:username', requireAuth, loadVisibleUser, (req, res) => {
  const { user: other, relationship } = req.other;
  const { changes } = db.prepare(
    'DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = ?'
  ).run(req.user.id, other.id, STATUS.BLOCKED);
  if (!changes) return res.status(404).json({ error: `You haven't blocked @${other.username}`, relation: relationship });
  res.json({ relation: RELATION.NONE, result: 'unblocked' });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Final error handler: always reply with JSON, never with Express's HTML page or a stack trace.
// Covers malformed or oversized JSON bodies and unexpected (e.g. SQL) errors.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  let error = status < 500 ? 'Bad request' : 'Something went wrong. Please try again.';
  if (err.type === 'entity.parse.failed') error = 'Request body is not valid JSON';
  else if (err.type === 'entity.too.large') error = 'Request body is too large';
  else if (status < 500 && err.expose) error = err.message;
  if (status >= 500) console.error(err);
  res.status(status).json({ error });
});

app.listen(PORT, () => {
  console.log(`Chirp running at http://localhost:${PORT}`);
});
