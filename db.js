import Database from 'better-sqlite3'

const DATA_DIR = process.env.DATA_DIR || '/data'

export const db = new Database(`${DATA_DIR}/collab.db`)

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id              TEXT    PRIMARY KEY,
    title           TEXT    NOT NULL DEFAULT '',
    data            BLOB,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    allow_anonymous INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER
  );
  CREATE TABLE IF NOT EXISTS users (
    username      TEXT    PRIMARY KEY,
    did           TEXT,
    registered_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`)

// Migration: add columns that may not exist in older databases.
try { db.exec(`ALTER TABLE documents ADD COLUMN owner TEXT`) } catch {}

// Migration: rebuild users table with did_key as primary key if still on old schema.
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
  if (!cols.includes('did_key')) {
    db.exec(`
      CREATE TABLE users_new (
        did_key       TEXT    PRIMARY KEY,
        did_web       TEXT,
        username      TEXT    NOT NULL,
        kvhost        TEXT    NOT NULL DEFAULT '',
        registered_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT OR IGNORE INTO users_new (did_key, did_web, username, kvhost, registered_at)
        SELECT did, did, username, '', registered_at FROM users WHERE did IS NOT NULL;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `)
  }
}
