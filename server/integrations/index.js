import { db } from '../db.js';
import { loadConfig } from '../config.js';
import * as jira from './jira.js';
import * as outlook from './outlook.js';

export const providers = { jira, outlook };

export function status() {
  const cfg = loadConfig();
  return Object.values(providers).map((p) => ({
    id: p.id,
    label: p.label,
    enabled: Boolean(cfg[p.id]?.enabled),
    configured: p.configured(cfg[p.id]),
    detail: p.describe(cfg[p.id]),
    last_sync: lastSync(p.id),
  }));
}

function lastSync(sourceType) {
  return db
    .prepare('SELECT MAX(synced_at) AS t FROM tasks WHERE source_type = ?')
    .get(sourceType).t;
}

const findByExternal = db.prepare(
  'SELECT * FROM tasks WHERE source_type = ? AND external_id = ?'
);

/**
 * Pull items from every configured provider and upsert them.
 *
 * Fields rodeo owns and never overwrites: status (unless the remote closed and
 * mirrorClosed is on), notes, estimate_hours, parent_id, priority, due_date once
 * you've set one locally. Fields the provider owns: title, description,
 * source_url, external_status.
 */
export async function syncAll({ only } = {}) {
  const cfg = loadConfig();
  const results = [];

  for (const p of Object.values(providers)) {
    if (only && p.id !== only) continue;
    const pcfg = cfg[p.id];
    if (!p.configured(pcfg)) {
      results.push({ provider: p.id, skipped: true, reason: p.describe(pcfg) });
      continue;
    }
    try {
      const items = await p.fetchItems(pcfg);
      results.push({ provider: p.id, ...upsert(p.id, items, pcfg) });
    } catch (err) {
      results.push({ provider: p.id, error: err.message });
    }
  }
  return results;
}

function upsert(sourceType, items, pcfg) {
  const ts = new Date().toISOString();
  let created = 0, updated = 0, closed = 0;

  const nextSort = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tasks WHERE parent_id IS NULL'
  );
  const insert = db.prepare(`
    INSERT INTO tasks (title, description, notes, status, priority, due_date, estimate_hours,
                       source_type, source_ref, source_url, external_id, external_status,
                       synced_at, parent_id, sort_order, created_at, updated_at)
    VALUES (?, ?, '', 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    for (const item of items) {
      const existing = findByExternal.get(sourceType, item.external_id);

      if (!existing) {
        if (item.closed) continue; // don't import things that are already finished
        insert.run(
          item.title,
          item.description ?? '',
          item.priority ?? 'normal',
          item.due_date ?? null,
          item.estimate_hours ?? null,
          sourceType,
          item.source_ref ?? null,
          item.source_url ?? null,
          item.external_id,
          item.external_status ?? null,
          ts,
          nextSort.get().n,
          ts,
          ts
        );
        created++;
        continue;
      }

      const sets = {
        title: item.title,
        description: item.description ?? existing.description,
        source_ref: item.source_ref ?? existing.source_ref,
        source_url: item.source_url ?? existing.source_url,
        external_status: item.external_status ?? null,
        synced_at: ts,
        updated_at: ts,
      };
      // Only fill a due date / estimate the remote knows and you haven't set locally.
      if (item.due_date && !existing.due_date) sets.due_date = item.due_date;
      if (item.estimate_hours && existing.estimate_hours == null) sets.estimate_hours = item.estimate_hours;

      if (item.closed && pcfg.mirrorClosed !== false && existing.status !== 'done') {
        sets.status = 'done';
        sets.completed_at = ts;
        closed++;
      }

      const cols = Object.keys(sets);
      db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map((c) => sets[c]), existing.id);
      updated++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { created, updated, closed, fetched: items.length };
}
