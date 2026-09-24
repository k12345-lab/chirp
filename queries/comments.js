import { getDb, nowIso } from '../db.js';
import { FRIEND_IDS_SQL } from './friends.js';

const db = getDb();

// A comment is shown to its author, the post's owner, and the commenter's accepted friends
// (so never to someone the commenter isn't friends with). Needs aliases c (comment), p (post).
export const COMMENT_VISIBLE_SQL = `(c.user_id = $me OR p.user_id = $me OR c.user_id IN (${FRIEND_IDS_SQL}))`;

const selectVisibleComments = db.prepare(`
  SELECT c.id, c.user_id, c.body, c.created_at, u.username, p.user_id AS post_owner_id
  FROM comments c
  JOIN users u ON u.id = c.user_id
  JOIN posts p ON p.id = c.post_id
  WHERE c.post_id = $post AND ${COMMENT_VISIBLE_SQL}
  ORDER BY c.created_at, c.id
`);
const insertComment = db.prepare('INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)');
// The comment's author or the post's owner may delete it.
const deleteComment = db.prepare(`
  DELETE FROM comments
  WHERE id = $id AND (user_id = $me OR post_id IN (SELECT id FROM posts WHERE user_id = $me))
`);

// The comments on a post that `meId` may see, oldest first: theirs, all of them on their own posts,
// and otherwise only those by their friends.
export function visibleComments(meId, postId) {
  return selectVisibleComments.all({ post: postId, me: meId }).map((c) => ({
    id: c.id,
    body: c.body,
    createdAt: c.created_at,
    username: c.username,
    canDelete: c.user_id === meId || c.post_owner_id === meId,
  }));
}

// Returns the new comment's id.
export function createComment(postId, userId, body) {
  return Number(insertComment.run(postId, userId, body, nowIso()).lastInsertRowid);
}

// Delete a comment `meId` wrote, or one on their post. Returns false if there's no such comment.
export function deleteCommentAs(meId, commentId) {
  return deleteComment.run({ id: commentId, me: meId }).changes > 0;
}
