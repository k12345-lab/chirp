import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRIENDSHIP_STATUS, HOUR } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'chirp.db');
const CLEANUP_INTERVAL_MS = HOUR;

let db = null;
let cleanupTimer = null;

// Every timestamp column (created_at, responded_at, expires_at) holds an ISO 8601 UTC string in
// exactly this format, e.g. "2025-01-31T09:05:00.000Z". Being fixed-width, they sort and compare
// correctly as text, which the queries rely on (ORDER BY created_at, expires_at > ?, cursors).
export const isoFromMs = (ms) => new Date(ms).toISOString();
export const nowIso = () => isoFromMs(Date.now());

// The open connection. Query modules call this when they're first imported (to prepare their
// statements once), so initDb() must have run before any of them is loaded.
export function getDb() {
  if (!db) throw new Error('The database is not open: call initDb() first');
  return db;
}

// Open (creating it if needed) and migrate the database, delete expired sessions, and repeat that
// cleanup hourly. `dbPath` defaults to DB_PATH or data/chirp.db; the folder that will hold the
// file is created if it's missing. Returns the connection.
export function initDb(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (db) throw new Error('The database is already open');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  db = new DatabaseSync(dbPath);
  // These can't be changed inside a transaction, so they're set before migrating.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    -- Overwrite deleted content with zeros, so text from deleted posts, comments and accounts
    -- doesn't linger in free pages of the database file (or in copies of it).
    PRAGMA secure_delete = ON;
  `);
  migrate();
  const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const cleanup = () => {
    deleteExpiredSessions.run(nowIso());
    checkpoint();
  };
  cleanup();
  // The timer doesn't keep the process alive; closeDb() stops it.
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();
  return db;
}

// Stop the cleanup timer and close the connection (which also checkpoints the WAL).
export function closeDb() {
  clearInterval(cleanupTimer);
  cleanupTimer = null;
  db?.close();
  db = null;
}

// Run `fn` inside a transaction and return its result; roll back if it throws.
export function transaction(fn) {
  getDb().exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Copy the write-ahead log into the database file and empty it. secure_delete only cleans the main
// file, so this keeps old page versions (with deleted text) from sitting in chirp.db-wal.
export function checkpoint() {
  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

// ---------- Schema and migrations ----------

const quote = (value) => `'${value}'`;

const friendshipsTable = (name) => `
  CREATE TABLE ${name} (
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN (${Object.values(FRIENDSHIP_STATUS).map(quote).join(', ')})),
    created_at   TEXT NOT NULL,
    responded_at TEXT,
    PRIMARY KEY (requester_id, addressee_id)
  )
`;

// MIGRATIONS[i] upgrades a database from schema version i to i + 1. The version is kept in
// PRAGMA user_version, which is 0 in a new database (and in ones made before versioning). Each
// migration runs in one transaction together with the version bump, so a failure leaves the
// database at the previous version. Never change a migration that has shipped; add a new one.
const MIGRATIONS = [
  // 1: The schema as it was before versioning. Creates every table in a new database, and brings
  //    older unversioned ones up to date: they may have raw-token sessions or a friendships table
  //    without the declined and blocked statuses.
  () => {
    // Sessions used to be stored as raw tokens in a `token` column; they are now stored as
    // SHA-256(token). Old rows can't be converted, so drop the table (everyone logs in again).
    const sessionColumns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all();
    if (sessionColumns.some((c) => c.name === 'token')) db.exec('DROP TABLE sessions');

    // Older databases only allowed 'pending' and 'accepted'. SQLite can't change a CHECK
    // constraint in place, so copy the rows into a table with the new schema (nothing references
    // friendships).
    const friendships = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'friendships'").get();
    if (!friendships) {
      db.exec(friendshipsTable('friendships'));
    } else if (!friendships.sql.includes(quote(FRIENDSHIP_STATUS.BLOCKED))) {
      db.exec(`
        ${friendshipsTable('friendships_new')};
        INSERT INTO friendships_new (requester_id, addressee_id, status, created_at)
          SELECT requester_id, addressee_id, status, created_at FROM friendships;
        DROP TABLE friendships;
        ALTER TABLE friendships_new RENAME TO friendships;
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );

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
  },

  // 2: sessions.created_at and expires_at were epoch milliseconds (INTEGER). Store them as ISO
  //    TEXT like every other timestamp. Existing sessions are converted, so nobody is logged out.
  () => {
    db.exec(`
      -- token_hash is the hex SHA-256 of the cookie value; the raw token is never stored.
      -- expires_at slides forward with use; created_at caps the session's total lifetime.
      CREATE TABLE sessions_new (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    const insert = db.prepare('INSERT INTO sessions_new (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
    for (const s of db.prepare('SELECT token_hash, user_id, created_at, expires_at FROM sessions').all()) {
      insert.run(s.token_hash, s.user_id, isoFromMs(Number(s.created_at)), isoFromMs(Number(s.expires_at)));
    }
    db.exec(`
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX sessions_user ON sessions(user_id);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate() {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version > SCHEMA_VERSION) {
    throw new Error(`The database is at schema version ${version}, newer than this version of Chirp supports (${SCHEMA_VERSION})`);
  }
  for (let v = version; v < SCHEMA_VERSION; v++) {
    transaction(() => {
      MIGRATIONS[v]();
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
