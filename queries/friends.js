import { getDb, nowIso, isoFromMs, transaction } from '../db.js';
import { DECLINE_COOLDOWN_MS, FRIENDSHIP_STATUS as STATUS, RELATION } from '../config.js';

const db = getDb();

// ---------- SQL fragments (also used by the other query modules) ----------

// SQL condition: the friendships row (alias prefix `f`, e.g. 'f.') is between users `a` and `b`,
// whichever of them sent it.
export const eitherDirectionSql = (a, b, f = '') =>
  `((${f}requester_id = ${a} AND ${f}addressee_id = ${b}) OR (${f}requester_id = ${b} AND ${f}addressee_id = ${a}))`;

// SQL condition: the friendships row involves $me, in either role.
export const involvesMeSql = (f = '') => `(${f}requester_id = $me OR ${f}addressee_id = $me)`;

// SQL expression: the id of the user at the other end of a friendships row from $me.
export const otherUserSql = (f = '') => `CASE WHEN ${f}requester_id = $me THEN ${f}addressee_id ELSE ${f}requester_id END`;

// Subquery that yields the ids of everyone who is an accepted friend of $me.
export const FRIEND_IDS_SQL = `
  SELECT ${otherUserSql()}
  FROM friendships
  WHERE status = '${STATUS.ACCEPTED}' AND ${involvesMeSql()}
`;

// SQL expression: the RELATION of $me to user alias u, given the friendships row alias f between
// them (LEFT JOINed, so NULL when there is none). Needs the $declinedSince parameter (see
// declinedSince()). Someone who declined a request sees NONE and may send a request themselves.
// SELF isn't covered: callers check for it themselves.
export const RELATION_SQL = `
  CASE
    WHEN f.status IS NULL THEN '${RELATION.NONE}'
    WHEN f.status = '${STATUS.ACCEPTED}' THEN '${RELATION.FRIENDS}'
    WHEN f.status = '${STATUS.PENDING}'
      THEN CASE WHEN f.requester_id = $me THEN '${RELATION.OUTGOING}' ELSE '${RELATION.INCOMING}' END
    WHEN f.status = '${STATUS.BLOCKED}'
      THEN CASE WHEN f.requester_id = $me THEN '${RELATION.BLOCKED}' ELSE '${RELATION.BLOCKED_BY}' END
    WHEN f.requester_id = $me AND f.responded_at > $declinedSince THEN '${RELATION.DECLINED}'
    ELSE '${RELATION.NONE}'
  END
`;

// A declined request stops the requester from asking again until this time has passed.
export const declinedSince = () => isoFromMs(Date.now() - DECLINE_COOLDOWN_MS);

// ---------- Statements ----------

const selectUserWithRelation = db.prepare(`
  SELECT u.id, u.username, u.created_at, ${RELATION_SQL} AS relation
  FROM users u
  LEFT JOIN friendships f ON ${eitherDirectionSql('$me', 'u.id', 'f.')}
  WHERE u.username = $username
`);
const selectFriendships = db.prepare(`
  SELECT f.requester_id, f.status, u.username
  FROM friendships f
  JOIN users u ON u.id = ${otherUserSql('f.')}
  WHERE ${involvesMeSql('f.')}
  ORDER BY u.username COLLATE NOCASE
`);
const countPending = db.prepare('SELECT COUNT(*) AS pending FROM friendships WHERE addressee_id = ? AND status = ?');
const deleteBetween = db.prepare(`DELETE FROM friendships WHERE ${eitherDirectionSql('$a', '$b')}`);
const insertFriendship = db.prepare(
  'INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, ?, ?)'
);
const updateResponse = db.prepare(
  'UPDATE friendships SET status = ?, responded_at = ? WHERE requester_id = ? AND addressee_id = ?'
);
const deleteBlock = db.prepare('DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = ?');

// ---------- Queries ----------

// The user called `username` as { id, username, created_at, relationship } where relationship is
// how `meId` relates to them (one of RELATION), or undefined if there's no such user.
export function findUserWithRelation(meId, username) {
  const row = selectUserWithRelation.get({ me: meId, username, declinedSince: declinedSince() });
  if (!row) return undefined;
  const { relation, ...user } = row;
  return { ...user, relationship: user.id === meId ? RELATION.SELF : relation };
}

// Your friends, requests in both directions, and the people you've blocked, each sorted by name.
// Requests you declined and requests of yours that were declined are left out.
export function listFriendships(meId) {
  const result = { friends: [], incoming: [], outgoing: [], blocked: [] };
  for (const r of selectFriendships.all({ me: meId })) {
    const mine = r.requester_id === meId;
    if (r.status === STATUS.ACCEPTED) result.friends.push(r.username);
    else if (r.status === STATUS.PENDING) result[mine ? 'outgoing' : 'incoming'].push(r.username);
    else if (r.status === STATUS.BLOCKED && mine) result.blocked.push(r.username);
  }
  return result;
}

export function countPendingRequests(meId) {
  return countPending.get(meId, STATUS.PENDING).pending;
}

// Remove whatever row exists between two users (both directions).
export function deleteFriendship(aId, bId) {
  deleteBetween.run({ a: aId, b: bId });
}

// Replace whatever row exists between two users with a new one from `requesterId` in `status`.
export function replaceFriendship(requesterId, addresseeId, status) {
  transaction(() => {
    deleteFriendship(requesterId, addresseeId);
    insertFriendship.run(requesterId, addresseeId, status, nowIso());
  });
}

// Accept or decline the pending request from `requesterId` to `addresseeId`.
export function respondToRequest(requesterId, addresseeId, status) {
  updateResponse.run(status, nowIso(), requesterId, addresseeId);
}

// Remove `blockerId`'s block of `blockedId`. Returns false if there was none.
export function unblock(blockerId, blockedId) {
  return deleteBlock.run(blockerId, blockedId, STATUS.BLOCKED).changes > 0;
}
