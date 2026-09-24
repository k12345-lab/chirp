// Signing up, logging in and out.
import express from 'express';
import { MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH, USERNAME_RE } from '../config.js';
import {
  DUMMY_PASSWORD_HASH, endAllSessions, endSession, hashPassword, needsRehash, passwordProblem,
  requireAuth, startSession, verifyPassword,
} from '../auth.js';
import { createUser, findCredentials, findUser, setPasswordHash } from '../queries/users.js';
import { loginIpLimiter, loginUserLimiter, signupLimiter } from '../middleware/rate-limits.js';
import { readCredentials } from '../middleware/validate.js';

const SQLITE_CONSTRAINT_UNIQUE = 2067;

const router = express.Router();

router.post('/signup', signupLimiter, async (req, res) => {
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
    userId = createUser(username, passwordHash);
  } catch (err) {
    // Someone else took the name while we were hashing.
    if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) return res.status(409).json({ error: 'That username is taken' });
    throw err;
  }
  startSession(req, res, userId);
  res.status(201).json({ username });
});

router.post('/login', loginIpLimiter, loginUserLimiter, async (req, res) => {
  const { username, password } = readCredentials(req);
  const user = findCredentials(username);
  // Always run scrypt, even for unknown usernames, so response time doesn't reveal which exist.
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  // Upgrade hashes made with older (cheaper) scrypt parameters.
  if (needsRehash(user.password_hash)) setPasswordHash(user.id, await hashPassword(password));
  startSession(req, res, user.id);
  res.json({ username: user.username });
});

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

// Ends every session of the current user, on all devices.
router.post('/logout-all', requireAuth, (req, res) => {
  endAllSessions(req, res, req.user.id);
  res.json({ ok: true });
});

export default router;
