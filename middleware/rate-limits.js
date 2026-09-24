import { rateLimit } from 'express-rate-limit';
import { HOUR, MINUTE } from '../config.js';
import { readCredentials } from './validate.js';

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

// Limiters keyed by user must come after requireAuth.
const byUser = (req) => `user:${req.user.id}`;

export const signupLimiter = limiter(HOUR, 10, 'sign-ups from your network');
// Only failed logins count. The per-username limit stops guessing one account's password from many
// addresses; the per-IP limit stops one address from trying many accounts.
export const loginIpLimiter = limiter(15 * MINUTE, 30, 'failed logins from your network', { skipSuccessfulRequests: true });
export const loginUserLimiter = limiter(15 * MINUTE, 10, 'failed logins for this account', {
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `username:${readCredentials(req).username.toLowerCase()}`,
});
export const postLimiter = limiter(15 * MINUTE, 30, 'posts', { keyGenerator: byUser });
export const commentLimiter = limiter(15 * MINUTE, 60, 'comments', { keyGenerator: byUser });
export const friendLimiter = limiter(HOUR, 50, 'friend requests', { keyGenerator: byUser });
export const blockLimiter = limiter(HOUR, 50, 'blocks', { keyGenerator: byUser });
// Searching and looking up usernames reveal who has an account, so they're limited too. Only
// lookups of names that don't exist (404) count, so browsing friends' profiles is unaffected.
export const userSearchLimiter = limiter(15 * MINUTE, 120, 'user searches', { keyGenerator: byUser });
export const userLookupLimiter = limiter(15 * MINUTE, 60, 'lookups of unknown users', {
  keyGenerator: byUser,
  skipSuccessfulRequests: true,
});
export const deleteAccountLimiter = limiter(15 * MINUTE, 5, 'failed attempts to delete your account', {
  keyGenerator: byUser,
  skipSuccessfulRequests: true,
});
export const exportLimiter = limiter(HOUR, 10, 'data exports', { keyGenerator: byUser });
