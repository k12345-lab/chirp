// The feed, posts, likes and comments.
import express from 'express';
import { MAX_COMMENT_LENGTH, MAX_POST_LENGTH } from '../config.js';
import { requireAuth } from '../auth.js';
import { createPost, deletePost, likePost, likeState, unlikePost, visiblePosts } from '../queries/posts.js';
import { createComment, deleteCommentAs, visibleComments } from '../queries/comments.js';
import { commentLimiter, postLimiter } from '../middleware/rate-limits.js';
import { parseId, searchQuery, validateBody } from '../middleware/validate.js';
import { requireVisiblePost } from '../middleware/loaders.js';

const router = express.Router();
router.param('id', parseId);

router.get('/feed', requireAuth, (req, res) => {
  const search = searchQuery(req, res);
  if (search === undefined) return;
  res.json(visiblePosts(req.user.id, { search: search || null, cursor: req.query.cursor }));
});

router.post('/posts', requireAuth, postLimiter, (req, res) => {
  const body = validateBody(req, res, 'Post', MAX_POST_LENGTH);
  if (body === undefined) return;
  res.status(201).json({ id: createPost(req.user.id, body) });
});

router.delete('/posts/:id', requireAuth, (req, res) => {
  if (!deletePost(req.user.id, req.id)) return res.status(404).json({ error: 'Post not found' });
  res.json({ ok: true });
});

// Both like routes reply with the post's current state so every client shows the server's truth.
router.post('/posts/:id/like', requireAuth, requireVisiblePost, (req, res) => {
  likePost(req.user.id, req.id);
  res.json(likeState(req.user.id, req.id));
});

router.delete('/posts/:id/like', requireAuth, requireVisiblePost, (req, res) => {
  unlikePost(req.user.id, req.id);
  res.json(likeState(req.user.id, req.id));
});

// Comments on a post, oldest first. Only those you may see are returned: yours, all of them on
// your own posts, and otherwise only those by your friends.
router.get('/posts/:id/comments', requireAuth, requireVisiblePost, (req, res) => {
  res.json(visibleComments(req.user.id, req.id));
});

router.post('/posts/:id/comments', requireAuth, commentLimiter, requireVisiblePost, (req, res) => {
  const body = validateBody(req, res, 'Comment', MAX_COMMENT_LENGTH);
  if (body === undefined) return;
  res.status(201).json({ id: createComment(req.id, req.user.id, body) });
});

router.delete('/comments/:id', requireAuth, (req, res) => {
  if (!deleteCommentAs(req.user.id, req.id)) return res.status(404).json({ error: 'Comment not found' });
  res.json({ ok: true });
});

export default router;
