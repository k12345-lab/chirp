// Passwords, session cookies and the middleware that identifies the logged-in user.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DAY, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './config.js';
import { COMMON_PASSWORDS } from './common-passwords.js';
import { isoFromMs } from './db.js';
import * as sessions from './queries/sessions.js';

const SESSION_IDLE_MS = 14 * DAY; // A session expires after 14 days without use...
const SESSION_MAX_MS = 90 * DAY; // ...and 90 days after login, however often it's used.
const SESSION_REFRESH_MS = DAY; // Slide the expiry forward at most once a day.
// Session cookies are Secure unless COOKIE_SECURE=false; see sessionCookie().
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const SESSION_COOKIE = '__Host-sid';
const DEV_SESSION_COOKIE = 'sid'; // Plain-HTTP localhost only; the __Host- prefix requires Secure.
const SESSION_TOKEN_BYTES = 32;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// ---------- Passwords ----------

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
export async function hashPassword(password) {
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
export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  try {
    const hash = await deriveKey(password, parsed.salt, parsed.params, parsed.hash.length);
    return crypto.timingSafeEqual(hash, parsed.hash);
  } catch {
    return false;
  }
}

// True if the hash was made with other (older, cheaper) scrypt parameters than today's.
export function needsRehash(stored) {
  const { N, r, p } = parsePasswordHash(stored)?.params ?? {};
  return N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p;
}

// Login checks unknown usernames against this, so they take as long as wrong passwords.
export const DUMMY_PASSWORD_HASH = await hashPassword(crypto.randomBytes(SCRYPT_SALT_LENGTH).toString('hex'));

// Why `password` can't be used at signup, or null if it's fine.
export function passwordProblem(password, username) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const lower = password.toLowerCase();
  if (lower === username.toLowerCase()) return "Password can't be the same as your username";
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common. Please choose another.';
  return null;
}

// ---------- Cookies ----------

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

// ---------- Sessions ----------

// Log the response's client in as `userId`: store a new session and set its cookie.
export function startSession(req, res, userId) {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
  const now = Date.now();
  sessions.createSession(hashToken(token), userId, isoFromMs(now), isoFromMs(now + SESSION_IDLE_MS));
  setSessionCookie(req, res, token, SESSION_IDLE_MS);
}

// Log out this client: delete its session (if any) and clear the cookie.
export function endSession(req, res) {
  const token = sessionToken(req);
  if (token) sessions.deleteSession(hashToken(token));
  clearSessionCookie(req, res);
}

// Log `userId` out everywhere: delete all their sessions and clear this client's cookie.
export function endAllSessions(req, res, userId) {
  sessions.deleteUserSessions(userId);
  clearSessionCookie(req, res);
}

// Middleware: set req.user = { id, username } if the session cookie is valid, and slide its expiry.
export function loadSession(req, res, next) {
  const token = sessionToken(req);
  if (!token) return next();
  const now = Date.now();
  const tokenHash = hashToken(token);
  const session = sessions.findLiveSession(tokenHash, isoFromMs(now));
  if (!session) return next();
  req.user = { id: session.id, username: session.username };
  const expiresAt = Math.min(now + SESSION_IDLE_MS, Date.parse(session.created_at) + SESSION_MAX_MS);
  if (expiresAt - Date.parse(session.expires_at) > SESSION_REFRESH_MS) {
    sessions.extendSession(tokenHash, isoFromMs(expiresAt));
    setSessionCookie(req, res, token, expiresAt - now);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
