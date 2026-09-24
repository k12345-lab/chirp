// The current user's own account: status, data export and deletion.
import express from 'express';
import { checkpoint, nowIso } from '../db.js';
import { endSession, requireAuth, verifyPassword } from '../auth.js';
import { countPendingRequests } from '../queries/friends.js';
import { deleteUser, exportUserData, getPasswordHash } from '../queries/users.js';
import { deleteAccountLimiter, exportLimiter } from '../middleware/rate-limits.js';

const router = express.Router();

router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, pendingRequests: countPendingRequests(req.user.id) });
});

// Delete your account. Body: { password }. Everything else you created (sessions, posts and the
// comments and likes on them, your comments, likes and friendships) goes with it via ON DELETE
// CASCADE, and secure_delete plus a checkpoint make sure the text doesn't linger in the file.
router.delete('/me', requireAuth, deleteAccountLimiter, async (req, res) => {
  const password = String(req.body?.password ?? '');
  // 403 rather than 401, which would mean "not logged in".
  if (!(await verifyPassword(password, getPasswordHash(req.user.id)))) {
    return res.status(403).json({ error: 'Incorrect password' });
  }
  deleteUser(req.user.id);
  checkpoint();
  endSession(req, res);
  res.json({ ok: true });
});

// Download everything Chirp stores about you, as JSON. Comments other people wrote on your
// posts are theirs, so they aren't included (only their count).
router.get('/me/export', requireAuth, exportLimiter, (req, res) => {
  const me = req.user.id;
  const { user, posts, comments, likes, friendships } = exportUserData(me);
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

export default router;
