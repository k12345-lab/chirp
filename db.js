import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'chirp.db');
// Create the folder that will actually hold the database (the default or a custom DB_PATH).
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

export const db = new DatabaseSync(dbPath);

// Sessions used to be stored as raw tokens in a `token` column; they are now stored as
// SHA-256(token). Old rows can't be converted, so drop the table (everyone logs in again).
const sessionColumns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all();
if (sessionColumns.some((c) => c.name === 'token')) db.exec('DROP TABLE sessions');

// One row per pair of users, keyed by who acted first:
// - 'pending':  requester asked addressee; 'accepted' once the addressee agrees.
// - 'declined': the addressee said no. The requester can't ask again until the cooldown in
//   server.js has passed (counted from responded_at); the addressee may still ask them.
// - 'blocked':  requester blocked addressee. The blocked user can't see or contact the blocker.
export const FRIENDSHIP_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  BLOCKED: 'blocked',
});
const quote = (value) => `'${value}'`;

const FRIENDSHIPS_TABLE = `
  CREATE TABLE IF NOT EXISTS friendships (
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN (${Object.values(FRIENDSHIP_STATUS).map(quote).join(', ')})),
    created_at   TEXT NOT NULL,
    responded_at TEXT,
    PRIMARY KEY (requester_id, addressee_id)
  )
`;

// Older databases only allowed 'pending' and 'accepted'. SQLite can't change a CHECK constraint
// in place, so copy the rows into a table with the new schema (nothing references friendships).
const oldFriendships = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'friendships'").get();
if (oldFriendships && !oldFriendships.sql.includes(quote(FRIENDSHIP_STATUS.BLOCKED))) {
  db.exec('BEGIN');
  try {
    db.exec(FRIENDSHIPS_TABLE.replace('friendships', 'friendships_new'));
    db.exec(`
      INSERT INTO friendships_new (requester_id, addressee_id, status, created_at)
        SELECT requester_id, addressee_id, status, created_at FROM friendships;
      DROP TABLE friendships;
      ALTER TABLE friendships_new RENAME TO friendships;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  -- Overwrite deleted content with zeros, so text from deleted posts, comments and accounts
  -- doesn't linger in free pages of the database file (or in copies of it).
  PRAGMA secure_delete = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  -- token_hash is the hex SHA-256 of the cookie value; the raw token is never stored.
  -- expires_at slides forward with use; created_at caps the session's total lifetime.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS posts_user_created ON posts(user_id, created_at);

  ${FRIENDSHIPS_TABLE};
  CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships(addressee_id);

  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, post_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_post_created ON comments(post_id, created_at);
`);

// Copy the write-ahead log into the database file and empty it. secure_delete only cleans the main
// file, so this keeps old page versions (with deleted text) from sitting in chirp.db-wal.
export function checkpoint() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

// Delete expired sessions and checkpoint at startup and then hourly (the timer doesn't keep the
// process alive).
function hourlyCleanup() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  checkpoint();
}
hourlyCleanup();
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // One hour.
setInterval(hourlyCleanup, CLEANUP_INTERVAL_MS).unref();
