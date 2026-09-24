import { RELATION } from '../config.js';
import { findUserWithRelation } from '../queries/friends.js';
import { isPostVisible } from '../queries/posts.js';

// Middleware for /:username routes, after requireAuth and any rate limiter: sets
// req.other = { user, relationship }, or replies 404 if there's no such user or they blocked you,
// so a block looks the same as a missing account. (Not router.param: param callbacks run before
// the route's requireAuth and rate limiters, and userLookupLimiter has to see these 404s.)
export function loadVisibleUser(req, res, next) {
  const found = findUserWithRelation(req.user.id, req.params.username);
  if (!found || found.relationship === RELATION.BLOCKED_BY) return res.status(404).json({ error: 'User not found' });
  const { relationship, ...user } = found;
  req.other = { user, relationship };
  next();
}

// Middleware for /api/posts/:id/... routes, after requireAuth: 404 unless you can see the post.
export function requireVisiblePost(req, res, next) {
  if (!isPostVisible(req.user.id, req.id)) return res.status(404).json({ error: 'Post not found' });
  next();
}
