// Searching for people and viewing profiles.
import express from 'express';
import { MIN_USER_SEARCH_LENGTH, RELATION } from '../config.js';
import { requireAuth } from '../auth.js';
import { searchUsers } from '../queries/users.js';
import { visiblePosts } from '../queries/posts.js';
import { userLookupLimiter, userSearchLimiter } from '../middleware/rate-limits.js';
import { searchQuery } from '../middleware/validate.js';
import { loadVisibleUser } from '../middleware/loaders.js';

const USER_RELATION_FILTERS = [
  RELATION.NONE, RELATION.FRIENDS, RELATION.OUTGOING, RELATION.INCOMING, RELATION.DECLINED, RELATION.BLOCKED,
];

const router = express.Router();

// One page of other users whose username starts with `q`, alphabetically. `relation` (optional)
// filters in SQL, before the page limit, so e.g. "Find people" isn't starved by friends. `cursor`
// is the last username seen. To keep the user list from being walked, a search that can return
// strangers (no relation filter, or 'none') needs at least MIN_USER_SEARCH_LENGTH characters.
// People who blocked you are never listed.
router.get('/users', requireAuth, userSearchLimiter, (req, res) => {
  const q = searchQuery(req, res);
  if (q === undefined) return;
  const relation = req.query.relation ? String(req.query.relation) : null;
  if (relation && !USER_RELATION_FILTERS.includes(relation)) {
    return res.status(400).json({ error: 'Unknown relation filter' });
  }
  if ((!relation || relation === RELATION.NONE) && q.length < MIN_USER_SEARCH_LENGTH) {
    return res.status(400).json({ error: `Type at least ${MIN_USER_SEARCH_LENGTH} characters of a username` });
  }
  const after = req.query.cursor ? String(req.query.cursor) : null;
  res.json(searchUsers(req.user.id, { prefix: q, relation, after }));
});

// Profile plus one page of posts. Pass `cursor` (the previous nextCursor) for later pages.
// `joined` is the month you signed up ("YYYY-MM"), shown only to yourself and friends (else null).
router.get('/users/:username', requireAuth, userLookupLimiter, loadVisibleUser, (req, res) => {
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

export default router;
