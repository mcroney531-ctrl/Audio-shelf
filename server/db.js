import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE books (
    id           INTEGER PRIMARY KEY,
    key          TEXT NOT NULL UNIQUE,          -- stable identity: folder + album
    folder       TEXT NOT NULL,                 -- absolute path of the containing folder
    title        TEXT NOT NULL,
    sort_title   TEXT NOT NULL,
    author       TEXT,
    narrator     TEXT,
    series       TEXT,
    series_index REAL,
    year         INTEGER,
    genre        TEXT,
    description  TEXT,
    duration     REAL NOT NULL DEFAULT 0,
    track_count  INTEGER NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL DEFAULT 0,
    cover        TEXT,                          -- filename inside data/covers
    fingerprint  TEXT NOT NULL,                 -- changes when files change on disk
    added_at     INTEGER NOT NULL,
    scanned_at   INTEGER NOT NULL
  );
  CREATE INDEX books_sort ON books(sort_title);
  CREATE INDEX books_author ON books(author);
  CREATE INDEX books_series ON books(series, series_index);

  CREATE TABLE tracks (
    id       INTEGER PRIMARY KEY,
    book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx      INTEGER NOT NULL,
    path     TEXT NOT NULL,
    title    TEXT,
    duration REAL NOT NULL DEFAULT 0,
    start    REAL NOT NULL DEFAULT 0,           -- offset within the book
    size     INTEGER NOT NULL DEFAULT 0,
    mtime    INTEGER NOT NULL DEFAULT 0,
    mime     TEXT NOT NULL DEFAULT 'audio/mpeg'
  );
  CREATE UNIQUE INDEX tracks_book_idx ON tracks(book_id, idx);

  CREATE TABLE chapters (
    id      INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx     INTEGER NOT NULL,
    title   TEXT NOT NULL,
    start   REAL NOT NULL,
    end     REAL NOT NULL
  );
  CREATE UNIQUE INDEX chapters_book_idx ON chapters(book_id, idx);

  CREATE TABLE progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    position   REAL NOT NULL DEFAULT 0,         -- seconds from the start of the book
    duration   REAL NOT NULL DEFAULT 0,
    finished   INTEGER NOT NULL DEFAULT 0,
    speed      REAL NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );
  CREATE INDEX progress_recent ON progress(user_id, updated_at DESC);

  CREATE TABLE bookmarks (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    position   REAL NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX bookmarks_book ON bookmarks(user_id, book_id, position);
  `,
];

const version = () => db.prepare('PRAGMA user_version').get().user_version;

/** Applies any pending migrations. Runs on import so statements can be prepared eagerly. */
export function migrate() {
  let current = version();
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { from: current, to: version() };
}

migrate();
