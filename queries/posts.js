import { getDb, nowIso } from '../db.js';
import { POSTS_PAGE_SIZE } from '../config.js';
import { FRIEND_IDS_SQL } from './friends.js';
import { COMMENT_VISIBLE_SQL } from './comments.js';
import { escapeLike } from './util.js';

const db = getDb();

// A post is visible to $me if it's theirs or an accepted friend's. Needs alias p (post).
const POST_VISIBLE_SQL = `(p.user_id = $me OR p.user_id IN (${FRIEND_IDS_SQL}))`;

// One page of visible posts, newest first. $author and $q (a LIKE pattern) are optional filters;
// $afterAt/$afterId are the cursor (the last post of the previous page).
const selectPostsPage = db.prepare(`
  SELECT p.id, p.user_id, p.body, p.created_at, u.username,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
    EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $me) AS liked,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND ${COMMENT_VISIBLE_SQL}) AS comment_count
  FROM posts p JOIN users u ON u.id = p.user_id
  WHERE ${POST_VISIBLE_SQL}
    AND ($author IS NULL OR p.user_id = $author)
    AND ($q IS NULL OR p.body LIKE $q ESCAPE '\\' OR u.username LIKE $q ESCAPE '\\')
    AND ($afterId IS NULL OR p.created_at < $afterAt OR (p.created_at = $afterAt AND p.id < $afterId))
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT $limit
`);
const selectVisible = db.prepare(`SELECT 1 FROM posts p WHERE p.id = $post AND ${POST_VISIBLE_SQL}`);
const insertPost = db.prepare('INSERT INTO posts (user_id, body, created_at) VALUES (?, ?, ?)');
const deleteOwnPost = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?');
const insertLike = db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)');
const deleteLike = db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?');
const selectLikeState = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM likes WHERE post_id = $post) AS like_count,
    EXISTS (SELECT 1 FROM likes WHERE post_id = $post AND user_id = $me) AS liked
`);

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
export function visiblePosts(meId, { authorId = null, search = null, cursor = null } = {}) {
  const after = parsePostCursor(cursor);
  const rows = selectPostsPage.all({
    me: meId,
    author: authorId,
    q: search ? `%${escapeLike(search)}%` : null,
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

export function isPostVisible(meId, postId) {
  return Boolean(selectVisible.get({ post: postId, me: meId }));
}

// Returns the new post's id.
export function createPost(userId, body) {
  return Number(insertPost.run(userId, body, nowIso()).lastInsertRowid);
}

// Delete `userId`'s own post (with its likes and comments). Returns false if they have no such post.
export function deletePost(userId, postId) {
  return deleteOwnPost.run(postId, userId).changes > 0;
}

// The post's like count and whether `meId` likes it, as { liked, likeCount }.
export function likeState(meId, postId) {
  const row = selectLikeState.get({ post: postId, me: meId });
  return { liked: Boolean(row.liked), likeCount: row.like_count };
}

export function likePost(meId, postId) {
  insertLike.run(meId, postId);
}

export function unlikePost(meId, postId) {
  deleteLike.run(meId, postId);
}
