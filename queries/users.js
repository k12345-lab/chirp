import { getDb, nowIso } from '../db.js';
import { FRIENDSHIP_STATUS as STATUS, RELATION, USERS_PAGE_SIZE } from '../config.js';
import { RELATION_SQL, declinedSince, eitherDirectionSql, involvesMeSql, otherUserSql } from './friends.js';
import { escapeLike } from './util.js';

const db = getDb();

const selectByName = db.prepare('SELECT id, username, created_at FROM users WHERE username = ?');
const selectCredentials = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
const selectPasswordHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
const insertUser = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
const updatePasswordHash = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const deleteUserById = db.prepare('DELETE FROM users WHERE id = ?');

// The relation to each user comes from one LEFT JOIN, so a page costs a single query.
const selectUsersPage = db.prepare(`
  SELECT username, relation FROM (
    SELECT u.username, ${RELATION_SQL} AS relation
    FROM users u
    LEFT JOIN friendships f ON ${eitherDirectionSql('$me', 'u.id', 'f.')}
    WHERE u.id != $me AND u.username LIKE $q ESCAPE '\\'
      AND ($after IS NULL OR u.username > $after)
  )
  WHERE relation != '${RELATION.BLOCKED_BY}' AND ($relation IS NULL OR relation = $relation)
  ORDER BY username COLLATE NOCASE
  LIMIT $limit
`);

const exportAccount = db.prepare('SELECT username, created_at FROM users WHERE id = ?');
const exportPosts = db.prepare(`
  SELECT p.id, p.body, p.created_at,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
  FROM posts p WHERE p.user_id = ? ORDER BY p.created_at, p.id
`);
const exportComments = db.prepare(`
  SELECT c.id, c.post_id, u.username AS post_author, c.body, c.created_at
  FROM comments c JOIN posts p ON p.id = c.post_id JOIN users u ON u.id = p.user_id
  WHERE c.user_id = ? ORDER BY c.created_at, c.id
`);
const exportLikes = db.prepare(`
  SELECT l.post_id, u.username AS post_author
  FROM likes l JOIN posts p ON p.id = l.post_id JOIN users u ON u.id = p.user_id
  WHERE l.user_id = ? ORDER BY l.post_id
`);
// Leaves out other people's blocks of you: those are their data, not yours.
const exportFriendships = db.prepare(`
  SELECT u.username, f.requester_id, f.status, f.created_at, f.responded_at
  FROM friendships f
  JOIN users u ON u.id = ${otherUserSql('f.')}
  WHERE ${involvesMeSql('f.')} AND NOT (f.status = '${STATUS.BLOCKED}' AND f.addressee_id = $me)
  ORDER BY u.username COLLATE NOCASE
`);

export function findUser(username) {
  return selectByName.get(username);
}

// { id, username, password_hash } for logging in, or undefined.
export function findCredentials(username) {
  return selectCredentials.get(username);
}

export function getPasswordHash(userId) {
  return selectPasswordHash.get(userId)?.password_hash;
}

// Returns the new user's id. Throws a SQLite constraint error if the name is taken.
export function createUser(username, passwordHash) {
  return Number(insertUser.run(username, passwordHash, nowIso()).lastInsertRowid);
}

export function setPasswordHash(userId, passwordHash) {
  updatePasswordHash.run(passwordHash, userId);
}

// ON DELETE CASCADE removes the user's sessions, posts (with the likes and comments on them),
// comments, likes and friendships.
export function deleteUser(userId) {
  deleteUserById.run(userId);
}

// One page of other users whose username starts with `prefix`, alphabetically, as
// { users: [{ username, relation }], nextCursor }. `relation` (optional) filters before the page
// limit; `after` is the last username of the previous page. People who blocked `meId` are never
// listed.
export function searchUsers(meId, { prefix, relation = null, after = null }) {
  const rows = selectUsersPage.all({
    me: meId,
    q: `${escapeLike(prefix)}%`,
    after,
    declinedSince: declinedSince(),
    relation,
    limit: USERS_PAGE_SIZE + 1,
  });
  const hasMore = rows.length > USERS_PAGE_SIZE;
  const users = rows.slice(0, USERS_PAGE_SIZE);
  return { users, nextCursor: hasMore ? users.at(-1).username : null };
}

// Everything stored about `meId`, for the data export (database rows, not yet formatted).
export function exportUserData(meId) {
  return {
    user: exportAccount.get(meId),
    posts: exportPosts.all(meId),
    comments: exportComments.all(meId),
    likes: exportLikes.all(meId),
    friendships: exportFriendships.all({ me: meId }),
  };
}
