import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.RODEO_DB || join(ROOT, 'data', 'rodeo.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const MIGRATIONS = [
  // 1 — core schema
  `
  CREATE TABLE tasks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'todo',
    priority       TEXT NOT NULL DEFAULT 'normal',
    due_date       TEXT,
    estimate_hours REAL,
    source_type    TEXT NOT NULL DEFAULT 'brain',
    source_ref     TEXT,
    source_url     TEXT,
    external_id    TEXT,
    external_status TEXT,
    synced_at      TEXT,
    parent_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    sort_order     REAL NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    completed_at   TEXT
  );
  CREATE INDEX idx_tasks_parent ON tasks(parent_id);
  CREATE INDEX idx_tasks_status ON tasks(status);
  CREATE INDEX idx_tasks_due ON tasks(due_date);
  CREATE UNIQUE INDEX idx_tasks_external ON tasks(source_type, external_id)
    WHERE external_id IS NOT NULL;

  CREATE TABLE deps (
    task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_id)
  );
  CREATE INDEX idx_deps_depends ON deps(depends_on_id);

  CREATE TABLE note_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_notes_task ON note_entries(task_id);
  `,
  // 2 — recurring tasks and pinning
  `
  ALTER TABLE tasks ADD COLUMN recur_rule TEXT;
  ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  `,
  // 3 — a task is todo, blocked, or done; nothing in between
  `
  UPDATE tasks SET status = 'todo' WHERE status IN ('doing', 'waiting');
  UPDATE tasks SET status = 'done' WHERE status = 'cancelled';
  `,
  // 4 — tag colors. Which tasks carry which tag is read from their titles,
  // so this table holds nothing but the color choice.
  `
  CREATE TABLE tag_colors (
    name  TEXT PRIMARY KEY,
    color TEXT NOT NULL
  );
  `,
  // 5 — mail from the second account lands as its own kind of work, "eCrash
  // Support", rather than under the account's name. Sync finds an existing task
  // by (source_type, external_id), so tasks pulled in before this have to come
  // along — left behind they'd be invisible to sync and imported a second time.
  `
  UPDATE tasks SET source_type = 'ecrash' WHERE source_type = 'outlook2';
  `,
];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
      console.log(`[dont-get-fired] applied migration ${v + 1}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

migrate();

export { DB_PATH, ROOT };
