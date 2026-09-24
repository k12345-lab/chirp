import { getDb } from '../db.js';

const db = getDb();

const insertSession = db.prepare(
  'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
);
const selectLiveSession = db.prepare(`
  SELECT u.id, u.username, s.created_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.expires_at > ?
`);
const updateExpiry = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');
const deleteByHash = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const deleteByUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');

// Timestamps are ISO strings (see db.js).
export function createSession(tokenHash, userId, createdAt, expiresAt) {
  insertSession.run(tokenHash, userId, createdAt, expiresAt);
}

// The unexpired session with this token hash, as { id, username, created_at, expires_at } (the id
// and username are the user's), or undefined.
export function findLiveSession(tokenHash, nowIso) {
  return selectLiveSession.get(tokenHash, nowIso);
}

export function extendSession(tokenHash, expiresAt) {
  updateExpiry.run(expiresAt, tokenHash);
}

export function deleteSession(tokenHash) {
  deleteByHash.run(tokenHash);
}

export function deleteUserSessions(userId) {
  deleteByUser.run(userId);
}
