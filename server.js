import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_POST_LENGTH = 280;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const POSTS_PAGE_SIZE = 50;
const USERS_PAGE_SIZE = 50;

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth helpers ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
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

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_MS);
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MS,
  });
}

// Attach req.user on every API request if the session cookie is valid.
app.use('/api', (req, res, next) => {
  const token = getCookie(req, 'sid');
  if (token) {
    req.user = db.prepare(`
      SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(token, Date.now());
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ---------- Friendship helpers ----------

// Subquery that yields the ids of everyone who is an accepted friend of $me.
const FRIEND_IDS_SQL = `
  SELECT CASE WHEN requester_id = $me THEN addressee_id ELSE requester_id END
  FROM friendships
  WHERE status = 'accepted' AND (requester_id = $me OR addressee_id = $me)
`;

// Returns 'self' | 'friends' | 'outgoing' | 'incoming' | 'none'.
function relation(meId, otherId) {
  if (meId === otherId) return 'self';
  const row = db.prepare(`
    SELECT requester_id, status FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).get(meId, otherId, otherId, meId);
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  return row.requester_id === meId ? 'outgoing' : 'incoming';
}

function findUser(username) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE username = ?').get(username);
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
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
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

function canSeePost(meId, postId) {
  return db.prepare(`
    SELECT 1 FROM posts WHERE id = $post AND (user_id = $me OR user_id IN (${FRIEND_IDS_SQL}))
  `).get({ post: postId, me: meId });
}

// ---------- Auth routes ----------

app.post('/api/signup', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 letters, numbers, or underscores' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (findUser(username)) {
    return res.status(409).json({ error: 'That username is taken' });
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
  ).run(username, hashPassword(password), new Date().toISOString());
  startSession(res, Number(lastInsertRowid));
  res.status(201).json({ username });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  startSession(res, user.id);
  res.json({ username: user.username });
});

app.post('/api/logout', (req, res) => {
  const token = getCookie(req, 'sid');
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const { pending } = db.prepare(
    "SELECT COUNT(*) AS pending FROM friendships WHERE addressee_id = ? AND status = 'pending'"
  ).get(req.user.id);
  res.json({ username: req.user.username, pendingRequests: pending });
});

// ---------- Post routes ----------

app.get('/api/feed', requireAuth, (req, res) => {
  const search = String(req.query.q ?? '').trim() || null;
  res.json(visiblePosts(req.user.id, { search, cursor: req.query.cursor }));
});

app.post('/api/posts', requireAuth, (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'Post cannot be empty' });
  if (body.length > MAX_POST_LENGTH) {
    return res.status(400).json({ error: `Posts are limited to ${MAX_POST_LENGTH} characters` });
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO posts (user_id, body, created_at) VALUES (?, ?, ?)'
  ).run(req.user.id, body, new Date().toISOString());
  res.status(201).json({ id: Number(lastInsertRowid) });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const { changes } = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user.id);
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

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!canSeePost(req.user.id, postId)) return res.status(404).json({ error: 'Post not found' });
  db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, postId);
  res.json(likeState(req.user.id, postId));
});

app.delete('/api/posts/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!canSeePost(req.user.id, postId)) return res.status(404).json({ error: 'Post not found' });
  db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  res.json(likeState(req.user.id, postId));
});

// ---------- Comment routes ----------

// Comments on a post are visible to anyone who can see the post, oldest first.
app.get('/api/posts/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!canSeePost(req.user.id, postId)) return res.status(404).json({ error: 'Post not found' });
  const rows = db.prepare(`
    SELECT c.id, c.user_id, c.body, c.created_at, u.username, p.user_id AS post_owner_id
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN posts p ON p.id = c.post_id
    WHERE c.post_id = ?
    ORDER BY c.created_at, c.id
  `).all(postId);
  res.json(rows.map((c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    username: c.username,
    // The comment's author or the post's owner may delete it.
    canDelete: c.user_id === req.user.id || c.post_owner_id === req.user.id,
  })));
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!canSeePost(req.user.id, postId)) return res.status(404).json({ error: 'Post not found' });
  const body = String(req.body?.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty' });
  if (body.length > MAX_POST_LENGTH) {
    return res.status(400).json({ error: `Comments are limited to ${MAX_POST_LENGTH} characters` });
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)'
  ).run(postId, req.user.id, body, new Date().toISOString());
  res.status(201).json({ id: Number(lastInsertRowid) });
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const { changes } = db.prepare(`
    DELETE FROM comments
    WHERE id = $id AND (user_id = $me OR post_id IN (SELECT id FROM posts WHERE user_id = $me))
  `).run({ id: Number(req.params.id), me: req.user.id });
  if (!changes) return res.status(404).json({ error: 'Comment not found' });
  res.json({ ok: true });
});

// ---------- User & friend routes ----------

// One page of other users, alphabetically. `relation` (optional) filters in SQL, before the
// page limit, so e.g. "Find people" isn't starved by friends. `cursor` is the last username seen.
app.get('/api/users', requireAuth, (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rel = req.query.relation ? String(req.query.relation) : null;
  if (rel && !['none', 'friends', 'outgoing', 'incoming'].includes(rel)) {
    return res.status(400).json({ error: 'Unknown relation filter' });
  }
  const rows = db.prepare(`
    SELECT username, relation FROM (
      SELECT u.username,
        CASE
          WHEN f.status IS NULL THEN 'none'
          WHEN f.status = 'accepted' THEN 'friends'
          WHEN f.requester_id = $me THEN 'outgoing'
          ELSE 'incoming'
        END AS relation
      FROM users u
      LEFT JOIN friendships f
        ON (f.requester_id = $me AND f.addressee_id = u.id) OR (f.requester_id = u.id AND f.addressee_id = $me)
      WHERE u.id != $me AND u.username LIKE $q ESCAPE '\\'
        AND ($after IS NULL OR u.username > $after)
    )
    WHERE $rel IS NULL OR relation = $rel
    ORDER BY username COLLATE NOCASE
    LIMIT $limit
  `).all({
    me: req.user.id,
    q: `%${escapeLike(q)}%`,
    after: req.query.cursor ? String(req.query.cursor) : null,
    rel,
    limit: USERS_PAGE_SIZE + 1,
  });
  const hasMore = rows.length > USERS_PAGE_SIZE;
  const users = rows.slice(0, USERS_PAGE_SIZE);
  res.json({ users, nextCursor: hasMore ? users.at(-1).username : null });
});

// Profile plus one page of posts. Pass `cursor` (the previous nextCursor) for later pages.
app.get('/api/users/:username', requireAuth, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const rel = relation(req.user.id, user.id);
  const canSee = rel === 'self' || rel === 'friends';
  const page = canSee ? visiblePosts(req.user.id, { authorId: user.id, cursor: req.query.cursor }) : null;
  res.json({
    username: user.username,
    joined: user.created_at,
    relation: rel,
    posts: page ? page.posts : null,
    nextCursor: page ? page.nextCursor : null,
  });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT f.requester_id, f.status, u.username
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = $me THEN f.addressee_id ELSE f.requester_id END
    WHERE f.requester_id = $me OR f.addressee_id = $me
    ORDER BY u.username COLLATE NOCASE
  `).all({ me: req.user.id });
  const result = { friends: [], incoming: [], outgoing: [] };
  for (const r of rows) {
    if (r.status === 'accepted') result.friends.push(r.username);
    else if (r.requester_id === req.user.id) result.outgoing.push(r.username);
    else result.incoming.push(r.username);
  }
  res.json(result);
});

const intentOf = (req) => String(req.body?.intent ?? req.query.intent ?? '');

// Body: { intent: 'request' | 'accept' }.
// - request: 201 if a new request was created; 200 if they had already asked you (it's accepted);
//   409 if you're already friends or already asked them.
// - accept: 200 if their pending request was accepted; 409 if there is no request to accept
//   (e.g. they canceled it), so a stale "Accept" button never sends a new request.
app.post('/api/friends/:username', requireAuth, (req, res) => {
  const intent = intentOf(req);
  if (intent !== 'request' && intent !== 'accept') {
    return res.status(400).json({ error: "intent must be 'request' or 'accept'" });
  }
  const other = findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });
  const rel = relation(req.user.id, other.id);
  if (rel === 'self') return res.status(400).json({ error: "You can't friend yourself" });

  if (rel === 'incoming') {
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?")
      .run(other.id, req.user.id);
    return res.json({ relation: 'friends', result: 'accepted' });
  }
  if (intent === 'accept') {
    return res.status(409).json({ error: `@${other.username} has no pending request to accept`, relation: rel });
  }
  if (rel === 'none') {
    db.prepare("INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(req.user.id, other.id, new Date().toISOString());
    return res.status(201).json({ relation: 'outgoing', result: 'created' });
  }
  const error = rel === 'friends' ? `You're already friends with @${other.username}` : 'Friend request already sent';
  res.status(409).json({ error, relation: rel });
});

// Remove the friendship row. Optional body { intent: 'cancel' | 'decline' | 'unfriend' } makes the
// request fail with 409 unless the relation still matches (so a stale "Cancel request" button
// can't unfriend someone who has since accepted). 404 if there was nothing to remove.
const DELETE_INTENTS = { cancel: 'outgoing', decline: 'incoming', unfriend: 'friends' };
app.delete('/api/friends/:username', requireAuth, (req, res) => {
  const intent = intentOf(req);
  if (intent && !DELETE_INTENTS[intent]) {
    return res.status(400).json({ error: "intent must be 'cancel', 'decline' or 'unfriend'" });
  }
  const other = findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });
  const rel = relation(req.user.id, other.id);
  if (rel === 'self') return res.status(400).json({ error: "You can't unfriend yourself" });
  if (rel === 'none') return res.status(404).json({ error: 'No friendship or request to remove', relation: rel });
  if (intent && DELETE_INTENTS[intent] !== rel) {
    return res.status(409).json({ error: 'That friendship has changed. Refresh and try again.', relation: rel });
  }
  db.prepare(`
    DELETE FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).run(req.user.id, other.id, other.id, req.user.id);
  res.json({ relation: 'none', result: 'removed' });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Chirp running at http://localhost:${PORT}`);
});
