import { db } from './db.js';

export const STATUSES = ['todo', 'blocked', 'done'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const SOURCES = ['brain', 'jira', 'outlook', 'ecrash', 'other'];

/**
 * How much text a description or a notes field may hold.
 *
 * Generous on purpose: a dragged-in email carries the whole thread, quoted
 * history and all, and truncating that loses exactly the part you kept it for.
 * Every task is still handed to the browser whole by /api/state, so this is the
 * knob to turn down if the list ever starts feeling heavy.
 */
export const MAX_DESCRIPTION = 50_000;
const CLOSED = new Set(['done']);

const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const missing = (msg) => { throw new HttpError(404, msg); };

/* ---------- tags ---------- */

/**
 * Tags live in the title as "#ecrash", which keeps one source of truth: retype
 * the title and the tags follow. "#QAD-1017" is a Jira key, not a tag.
 */
const TAG_RE = /(?:^|\s)#([A-Za-z][A-Za-z0-9_-]*)/g;
const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export function extractTags(title) {
  const out = [];
  for (const [, word] of String(title || '').matchAll(TAG_RE)) {
    if (JIRA_KEY_RE.test(word)) continue;
    const tag = word.toLowerCase();
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

// Mid-tone hues: one hex has to read well against both the light and dark panel.
const TAG_PALETTE = [
  '#2f9e9a', '#7a5af5', '#c98a00', '#2f9e44',
  '#1b6ef3', '#e8590c', '#c2247c', '#0b8fa8',
];

const selectColors = db.prepare('SELECT name, color FROM tag_colors');
const insertColor = db.prepare('INSERT OR IGNORE INTO tag_colors (name, color) VALUES (?, ?)');
const upsertColor = db.prepare(`
  INSERT INTO tag_colors (name, color) VALUES (?, ?)
  ON CONFLICT(name) DO UPDATE SET color = excluded.color
`);

/** Every tag in use, with its color and how many tasks carry it. */
export function tagSummary() {
  const counts = new Map();
  for (const { title } of db.prepare('SELECT title FROM tasks').all()) {
    for (const tag of extractTags(title)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  const colors = new Map(selectColors.all().map((r) => [r.name, r.color]));
  // A tag earns a color the first time it shows up, preferring hues not yet taken.
  for (const tag of [...counts.keys()].sort()) {
    if (colors.has(tag)) continue;
    const used = new Set(colors.values());
    const color = TAG_PALETTE.find((c) => !used.has(c)) ?? TAG_PALETTE[colors.size % TAG_PALETTE.length];
    insertColor.run(tag, color);
    colors.set(tag, color);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, color: colors.get(name), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function setTagColor(name, color) {
  const tag = String(name || '').toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(tag)) bad('that is not a usable tag name');
  if (!/^#[0-9a-f]{6}$/i.test(String(color || ''))) bad('color must be a hex value like #2f9e9a');
  upsertColor.run(tag, String(color).toLowerCase());
  return tagSummary();
}

/* ---------- recurrence ---------- */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Only weekly rules for now, e.g. "weekly:mon". */
function parseRecur(rule) {
  const m = /^weekly:(sun|mon|tue|wed|thu|fri|sat)$/.exec(rule || '');
  return m ? { unit: 'weekly', weekday: WEEKDAYS.indexOf(m[1]) } : null;
}

const localToday = () => new Date().toLocaleDateString('en-CA');

/**
 * The next matching weekday strictly after both today and the current due date:
 * finishing late still skips to the coming week, finishing early doesn't double up.
 */
export function nextDueDate(rule, currentDue, today = localToday()) {
  const parsed = parseRecur(rule);
  if (!parsed) return null;
  const from = currentDue && currentDue > today ? currentDue : today;
  const d = new Date(`${from}T00:00:00`);
  const delta = (parsed.weekday - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d.toLocaleDateString('en-CA');
}

/* ---------- validation ---------- */

function clean(patch, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.hasOwn(patch, k);

  if (has('title')) {
    const t = String(patch.title ?? '').trim();
    if (!t) bad('title is required');
    if (t.length > 500) bad('title is too long (max 500)');
    out.title = t;
  } else if (!partial) bad('title is required');

  for (const k of ['description', 'notes', 'source_ref', 'source_url']) {
    if (has(k)) out[k] = patch[k] == null ? (k === 'description' || k === 'notes' ? '' : null) : String(patch[k]).trim();
  }
  for (const k of ['description', 'notes']) {
    if (out[k]?.length > MAX_DESCRIPTION) bad(`${k} is too long (max ${MAX_DESCRIPTION})`);
  }
  if (out.source_url) {
    // allow http(s) and outlook/ms-protocol style links, reject javascript: etc.
    if (!/^(https?:|ms-outlook:|mailto:|onenote:|msteams:)/i.test(out.source_url)) {
      bad('source_url must be an http(s), mailto:, or ms-outlook: link');
    }
  }

  if (has('status')) {
    if (!STATUSES.includes(patch.status)) bad(`status must be one of: ${STATUSES.join(', ')}`);
    out.status = patch.status;
  }
  if (has('priority')) {
    if (!PRIORITIES.includes(patch.priority)) bad(`priority must be one of: ${PRIORITIES.join(', ')}`);
    out.priority = patch.priority;
  }
  if (has('source_type')) {
    if (!SOURCES.includes(patch.source_type)) bad(`source must be one of: ${SOURCES.join(', ')}`);
    out.source_type = patch.source_type;
  }
  if (has('due_date')) {
    const d = patch.due_date;
    if (d == null || d === '') out.due_date = null;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) bad('due_date must be YYYY-MM-DD');
    else out.due_date = d;
  }
  if (has('estimate_hours')) {
    const h = patch.estimate_hours;
    if (h == null || h === '') out.estimate_hours = null;
    else {
      const n = Number(h);
      if (!Number.isFinite(n) || n < 0 || n > 10000) bad('estimate_hours must be a number between 0 and 10000');
      out.estimate_hours = n;
    }
  }
  if (has('archived')) out.archived = patch.archived ? 1 : 0;
  if (has('pinned')) out.pinned = patch.pinned ? 1 : 0;
  if (has('recur_rule')) {
    const r = patch.recur_rule;
    if (r == null || r === '') out.recur_rule = null;
    else {
      const rule = String(r).trim().toLowerCase();
      if (!parseRecur(rule)) bad(`recur_rule must look like "weekly:mon" (${WEEKDAYS.join('/')})`);
      out.recur_rule = rule;
    }
  }
  for (const k of ['external_id', 'external_status', 'synced_at']) {
    if (has(k)) out[k] = patch[k] == null ? null : String(patch[k]);
  }
  return out;
}

/* ---------- reads ---------- */

const selectDescription = db.prepare('SELECT id, description FROM tasks WHERE id = ?');

/** The text snapshot() leaves behind, fetched when an editor opens. */
export function description(id) {
  const row = selectDescription.get(id);
  if (!row) throw new HttpError(404, `no task ${id}`);
  return row;
}

const searchDescriptions = db.prepare(
  "SELECT id FROM tasks WHERE description <> '' AND instr(lower(description), lower(?)) > 0"
);

/**
 * Which tasks have a description matching this text.
 *
 * The browser still searches titles, notes and references itself — it holds those.
 * Description is the one field it no longer has, so that search happens here and
 * comes back as bare ids for the client to fold into its own filter.
 */
export function idsMatchingDescription(q) {
  const needle = String(q ?? '').trim();
  if (!needle) return [];
  return searchDescriptions.all(needle).map((r) => r.id);
}

const selectAll = db.prepare('SELECT * FROM tasks ORDER BY sort_order, id');
const selectOne = db.prepare('SELECT * FROM tasks WHERE id = ?');
const selectDeps = db.prepare('SELECT task_id, depends_on_id FROM deps');
const selectNotes = db.prepare('SELECT * FROM note_entries ORDER BY created_at DESC, id DESC');

export function getTask(id) {
  const row = selectOne.get(id);
  if (!row) missing(`task ${id} not found`);
  return row;
}

/** Full snapshot the UI renders from: tasks + dependency edges + note entries. */
/**
 * Every task, without its description.
 *
 * A dragged-in email carries its whole thread, so descriptions can run to tens of
 * thousands of characters — and this snapshot is rebuilt on every refresh, for
 * every task, when at most one of them is open in an editor. `has_description`
 * is all the list needs; the text itself is fetched when something asks to see it.
 */
export function snapshot() {
  const tasks = selectAll.all().map(({ description, ...t }) => ({
    ...t,
    has_description: Boolean(description),
    archived: !!t.archived, pinned: !!t.pinned, tags: extractTags(t.title),
  }));
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const t of tasks) { t.blocked_by = []; t.blocking = []; t.notes_log = []; }
  for (const { task_id, depends_on_id } of selectDeps.all()) {
    byId.get(task_id)?.blocked_by.push(depends_on_id);
    byId.get(depends_on_id)?.blocking.push(task_id);
  }
  for (const n of selectNotes.all()) byId.get(n.task_id)?.notes_log.push(n);

  // A task is gated when any dependency is still open.
  for (const t of tasks) {
    t.is_open = !CLOSED.has(t.status);
    t.gated_by = t.blocked_by.filter((id) => {
      const dep = byId.get(id);
      return dep && !CLOSED.has(dep.status);
    });
  }
  return tasks;
}

/* ---------- writes ---------- */

const nextSort = db.prepare(
  'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tasks WHERE parent_id IS ?'
);
const firstSort = db.prepare(
  'SELECT COALESCE(MIN(sort_order), 0) - 1 AS n FROM tasks WHERE parent_id IS ?'
);

export function createTask(input = {}) {
  const f = clean(input);
  const parentId = normalizeParent(input.parent_id);
  if (parentId != null) getTask(parentId);
  if (input.place != null && !['top', 'bottom'].includes(input.place)) {
    bad('place must be "top" or "bottom"');
  }
  // New work lands at the top of its list; the bottom is opt-in.
  const slot = input.place === 'bottom' ? nextSort : firstSort;

  const ts = now();
  const row = {
    title: f.title,
    description: f.description ?? '',
    notes: f.notes ?? '',
    status: f.status ?? 'todo',
    priority: f.priority ?? 'normal',
    due_date: f.due_date ?? null,
    estimate_hours: f.estimate_hours ?? null,
    source_type: f.source_type ?? 'brain',
    source_ref: f.source_ref ?? null,
    source_url: f.source_url ?? null,
    external_id: f.external_id ?? null,
    external_status: f.external_status ?? null,
    synced_at: f.synced_at ?? null,
    pinned: f.pinned ?? 0,
    recur_rule: f.recur_rule ?? null,
    parent_id: parentId,
    sort_order: slot.get(parentId).n,
    created_at: ts,
    updated_at: ts,
    completed_at: (f.status && CLOSED.has(f.status)) ? ts : null,
  };
  const cols = Object.keys(row);
  const stmt = db.prepare(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  );
  const { lastInsertRowid } = stmt.run(...cols.map((c) => row[c]));
  const created = getTask(Number(lastInsertRowid));

  if (Array.isArray(input.blocked_by)) {
    for (const depId of input.blocked_by) addDep(created.id, depId);
  }
  return created;
}

export function updateTask(id, patch = {}) {
  const existing = getTask(id);
  const f = clean(patch, { partial: true });

  if (Object.hasOwn(patch, 'parent_id')) {
    const parentId = normalizeParent(patch.parent_id);
    if (parentId != null) {
      if (parentId === id) bad('a task cannot be its own parent');
      getTask(parentId);
      if (descendantIds(id).has(parentId)) bad('that move would create a loop in the task tree');
    }
    f.parent_id = parentId;
    f.sort_order = nextSort.get(parentId).n;
  }

  if (f.status && f.status !== existing.status) {
    f.completed_at = CLOSED.has(f.status) ? now() : null;
  }

  // Closing a recurring task hands its rule to a fresh copy. Clearing the rule here
  // is what makes that happen exactly once, however often you reopen and re-close.
  const closing = Boolean(f.status) && CLOSED.has(f.status) && !CLOSED.has(existing.status);
  const passedOnRule = closing && existing.recur_rule && !Object.hasOwn(patch, 'recur_rule')
    ? existing.recur_rule
    : null;
  if (passedOnRule) f.recur_rule = null;

  const cols = Object.keys(f);
  if (cols.length) {
    f.updated_at = now();
    const sets = Object.keys(f).map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...Object.keys(f).map((c) => f[c]), id);
  }

  if (Array.isArray(patch.blocked_by)) setDeps(id, patch.blocked_by);
  if (passedOnRule) spawnNextOccurrence({ ...existing, ...f, recur_rule: passedOnRule });
  return getTask(id);
}

/** Copy a finished recurring task forward: same shape, next due date, empty notes. */
function spawnNextOccurrence(task) {
  const due = nextDueDate(task.recur_rule, task.due_date);
  if (!due) return null;
  const ts = now();
  const row = {
    title: task.title,
    description: task.description ?? '',
    notes: '',
    status: 'todo',
    priority: task.priority,
    due_date: due,
    estimate_hours: task.estimate_hours ?? null,
    source_type: task.source_type,
    source_ref: task.source_ref ?? null,
    source_url: task.source_url ?? null,
    parent_id: task.parent_id ?? null,
    sort_order: task.sort_order,
    pinned: task.pinned ?? 0,
    recur_rule: task.recur_rule,
    created_at: ts,
    updated_at: ts,
  };
  const cols = Object.keys(row);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(lastInsertRowid);
}

export function deleteTask(id) {
  getTask(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id); // children cascade
  return { deleted: id };
}

function normalizeParent(v) {
  if (v == null || v === '' || v === 0) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) bad('parent_id must be a task id');
  return n;
}

const childIdsOf = db.prepare('SELECT id FROM tasks WHERE parent_id = ?');
function descendantIds(rootId) {
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    for (const { id } of childIdsOf.all(queue.pop())) {
      if (!seen.has(id)) { seen.add(id); queue.push(id); }
    }
  }
  return seen;
}

/* ---------- dependencies ---------- */

const dependenciesOf = db.prepare('SELECT depends_on_id FROM deps WHERE task_id = ?');

/** Walk the dependency graph upstream from `startId`; true if it reaches `targetId`. */
function dependsOnTransitively(startId, targetId) {
  const seen = new Set();
  const queue = [startId];
  while (queue.length) {
    const cur = queue.pop();
    if (cur === targetId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const { depends_on_id } of dependenciesOf.all(cur)) queue.push(depends_on_id);
  }
  return false;
}

export function addDep(taskId, dependsOnId) {
  const a = Number(taskId), b = Number(dependsOnId);
  if (!Number.isInteger(a) || !Number.isInteger(b)) bad('dependency ids must be task ids');
  if (a === b) bad('a task cannot depend on itself');
  getTask(a); getTask(b);
  if (dependsOnTransitively(b, a)) bad(`R-${b} already depends on R-${a} — that would be a circular dependency`);
  db.prepare('INSERT OR IGNORE INTO deps (task_id, depends_on_id) VALUES (?, ?)').run(a, b);
  return { task_id: a, depends_on_id: b };
}

export function removeDep(taskId, dependsOnId) {
  db.prepare('DELETE FROM deps WHERE task_id = ? AND depends_on_id = ?').run(Number(taskId), Number(dependsOnId));
  return { removed: true };
}

function setDeps(taskId, ids) {
  const wanted = [...new Set(ids.map(Number).filter(Number.isInteger))];
  const current = dependenciesOf.all(taskId).map((r) => r.depends_on_id);
  for (const id of current) if (!wanted.includes(id)) removeDep(taskId, id);
  for (const id of wanted) if (!current.includes(id)) addDep(taskId, id);
}

/* ---------- note entries ---------- */

export function addNote(taskId, body) {
  getTask(taskId);
  const text = String(body ?? '').trim();
  if (!text) bad('note cannot be empty');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO note_entries (task_id, body, created_at) VALUES (?, ?, ?)')
    .run(Number(taskId), text, now());
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), Number(taskId));
  return db.prepare('SELECT * FROM note_entries WHERE id = ?').get(Number(lastInsertRowid));
}

export function deleteNote(noteId) {
  db.prepare('DELETE FROM note_entries WHERE id = ?').run(Number(noteId));
  return { deleted: Number(noteId) };
}

/* ---------- reordering ---------- */

export function reorder(id, opts = {}) {
  const task = getTask(id);
  const { after_id } = opts;
  const parentId = Object.hasOwn(opts, 'parent_id') ? normalizeParent(opts.parent_id) : task.parent_id;
  if (parentId != null) {
    if (parentId === Number(id)) bad('a task cannot be its own parent');
    getTask(parentId);
    if (descendantIds(Number(id)).has(parentId)) bad('that move would create a loop in the task tree');
  }
  const siblings = db
    .prepare('SELECT id, sort_order FROM tasks WHERE parent_id IS ? AND id != ? ORDER BY sort_order, id')
    .all(parentId, Number(id));

  let sort;
  if (after_id == null) {
    sort = (siblings[0]?.sort_order ?? 1) - 1;
  } else {
    const idx = siblings.findIndex((s) => s.id === Number(after_id));
    if (idx === -1) bad('after_id is not a sibling of the target position');
    const before = siblings[idx].sort_order;
    const next = siblings[idx + 1]?.sort_order;
    sort = next == null ? before + 1 : (before + next) / 2;
  }
  db.prepare('UPDATE tasks SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?')
    .run(parentId, sort, now(), Number(id));
  return getTask(id);
}

export { HttpError, CLOSED };
