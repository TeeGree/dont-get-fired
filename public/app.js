/* rodeo — single-page task wrangler */

const state = {
  tasks: [],
  byId: new Map(),
  integrations: [],
  tags: [],
  meta: { statuses: [], priorities: [], sources: [] },
  view: ['all', 'closed'].includes(localStorage.getItem('rodeo.view')) ? localStorage.getItem('rodeo.view') : 'all',
  query: '',
  expanded: new Set(JSON.parse(localStorage.getItem('rodeo.expanded') || '[]')),
  collapsed: new Set(JSON.parse(localStorage.getItem('rodeo.collapsed') || '[]')),
};

const CLOSED = new Set(['done']);
const $ = (sel) => document.querySelector(sel);

/* ---------- tiny DOM helper ---------- */

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/* ---------- api ---------- */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  clearTimeout(toastTimer);
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: `toast${isError ? ' err' : ''}`, text: msg });
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), isError ? 6000 : 2800);
}

async function refresh() {
  // Once the server knows a task is done it drops out of the list, which would cut
  // its flourish short. Let whatever is still playing finish first.
  if (completing.size) await Promise.allSettled([...completing.values()].map((c) => c.play));
  const data = await api('GET', '/api/state');
  state.tasks = data.tasks;
  state.byId = new Map(data.tasks.map((t) => [t.id, t]));
  state.integrations = data.integrations;
  state.tags = data.tags ?? [];
  state.meta = data.meta;
  state.today = data.server_date;
  render();
}

/* ---------- dates ---------- */

const todayStr = () => state.today || new Date().toLocaleDateString('en-CA');

function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysUntil(dateStr) {
  const a = parseDate(todayStr());
  const b = parseDate(dateStr);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

function formatDue(dateStr) {
  const d = daysUntil(dateStr);
  if (d == null) return '';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return '1d late';
  if (d < 0) return `${-d}d late`;
  if (d <= 6) return parseDate(dateStr).toLocaleDateString(undefined, { weekday: 'short' });
  return parseDate(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dueClass(t) {
  if (!t.due_date || CLOSED.has(t.status)) return '';
  const d = daysUntil(t.due_date);
  return d < 0 ? 'overdue' : d === 0 ? 'today' : '';
}

/* ---------- quick-add parsing ---------- */
/* "Fix totals !high @2026-09-01 ~3h #QAD-1017"  */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function resolveDateToken(tok) {
  const t = tok.toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const base = parseDate(todayStr());
  const shift = (n) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('en-CA');
  };
  if (t === 'today') return shift(0);
  if (t === 'tomorrow' || t === 'tmrw') return shift(1);
  if (/^\+\d+d?$/.test(t)) return shift(Number(t.replace(/[^\d]/g, '')));
  const wd = WEEKDAYS.indexOf(t.slice(0, 3));
  if (wd >= 0) {
    const delta = (wd - base.getDay() + 7) % 7 || 7;
    return shift(delta);
  }
  return null;
}

function parseQuickAdd(raw) {
  const out = { title: '', priority: 'normal', source_type: 'brain' };
  const words = [];
  for (const word of raw.trim().split(/\s+/)) {
    let m;
    if ((m = word.match(/^!(low|normal|high|urgent)$/i))) { out.priority = m[1].toLowerCase(); continue; }
    if ((m = word.match(/^~([\d.]+)h?$/i))) { out.estimate_hours = Number(m[1]); continue; }
    if (word.startsWith('@') && word.length > 1) {
      const d = resolveDateToken(word.slice(1));
      if (d) { out.due_date = d; continue; }
    }
    if ((m = word.match(/^#([A-Za-z][A-Za-z0-9_]*-\d+)$/))) {
      out.source_type = 'jira'; out.source_ref = m[1].toUpperCase(); continue;
    }
    words.push(word);
  }
  out.title = words.join(' ').trim();
  return out;
}

/* ---------- tags ---------- */
/* Tags live in the title as "#ecrash" — retype the title and the tags follow. */

const TAG_RE = /(?:^|\s)#([A-Za-z][A-Za-z0-9_-]*)/g;
const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

const tagColor = (name) => state.tags.find((x) => x.name === name)?.color || 'var(--ink-3)';

/** The title split into text and #tag nodes, each tag painted in its own colour. */
function titleNodes(title) {
  const out = [];
  let at = 0;
  for (const m of String(title).matchAll(TAG_RE)) {
    if (JIRA_KEY_RE.test(m[1])) continue;
    const hash = m.index + m[0].length - m[1].length - 1;
    if (hash > at) out.push(document.createTextNode(title.slice(at, hash)));
    const span = h('span', { class: 'tag', text: `#${m[1]}` });
    span.style.setProperty('--tag', tagColor(m[1].toLowerCase()));
    out.push(span);
    at = hash + m[1].length + 1;
  }
  if (at < title.length) out.push(document.createTextNode(title.slice(at)));
  return out;
}

/* ---------- tree shaping ---------- */

function childrenOf(id) {
  return state.tasks
    .filter((t) => t.parent_id === id)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

function subtree(t, acc = []) {
  acc.push(t);
  for (const c of childrenOf(t.id)) subtree(c, acc);
  return acc;
}

function rollupHours(t) {
  return subtree(t)
    .filter((x) => !CLOSED.has(x.status))
    .reduce((sum, x) => sum + (x.estimate_hours || 0), 0);
}

/**
 * A repeating task's next occurrence waits its turn: it exists so completing one
 * schedules the next, but it stays out of the list until its date comes around.
 */
function isScheduled(t) {
  return Boolean(t.recur_rule) && !CLOSED.has(t.status)
    && t.due_date != null && daysUntil(t.due_date) > 0;
}

function matchesView(t) {
  const open = !CLOSED.has(t.status);
  if (state.view === 'closed') return !open;
  return open && !isScheduled(t);
}

function matchesQuery(t) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [t.title, t.description, t.notes, t.source_ref, `r-${t.id}`]
    .some((f) => (f || '').toLowerCase().includes(q));
}

/** ids to render: direct hits plus every ancestor, so the tree keeps its shape */
function visibleIds() {
  const hits = state.tasks.filter((t) => matchesView(t) && matchesQuery(t));
  const ids = new Set();
  for (const t of hits) {
    ids.add(t.id);
    let p = t.parent_id;
    while (p != null && !ids.has(p)) { ids.add(p); p = state.byId.get(p)?.parent_id ?? null; }
  }
  return { ids, hitIds: new Set(hits.map((t) => t.id)) };
}

/* ---------- drag to reorder ---------- */

let dragId = null;
let lastRootId = null; // bottom of the list as currently rendered

/** The closed view sorts by completion date, and a search shows a partial list. */
function manualOrder() {
  return state.view === 'all' && !state.query.trim();
}

function siblingsOf(parentId) {
  return state.tasks
    .filter((t) => (t.parent_id ?? null) === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
}

function isAncestorOf(id, maybeDescendantId) {
  let p = state.byId.get(maybeDescendantId)?.parent_id ?? null;
  while (p != null) {
    if (p === id) return true;
    p = state.byId.get(p)?.parent_id ?? null;
  }
  return false;
}

/** Drop lands the dragged task as a sibling of the target, above or below it. */
async function dropOn(targetId, before) {
  const id = dragId;
  if (id == null || id === targetId) return;
  if (isAncestorOf(id, targetId)) return toast('A task cannot be moved inside itself', true);

  const parentId = state.byId.get(targetId)?.parent_id ?? null;
  const sibs = siblingsOf(parentId).filter((s) => s.id !== id);
  const idx = sibs.findIndex((s) => s.id === targetId);
  const afterId = before ? (idx > 0 ? sibs[idx - 1].id : null) : targetId;

  try {
    await api('POST', `/api/tasks/${id}/move`, { parent_id: parentId, after_id: afterId });
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  $('#tree').classList.remove('drop-end');
}

/** Send the task to the end of the top level, re-parenting it out if it was nested. */
async function dropAtEnd() {
  const id = dragId;
  if (id == null || lastRootId == null || id === lastRootId) return;
  try {
    await api('POST', `/api/tasks/${id}/move`, { parent_id: null, after_id: lastRootId });
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * The rows stop at the last task, but the pane keeps going. Treat anything dragged
 * below the final row as "put it at the bottom" so you can throw it there.
 */
function bindEndZone() {
  const pane = document.querySelector('.list-pane');
  const tree = $('#tree');

  const belowLastRow = (e) => {
    if (dragId == null || !manualOrder()) return false;
    if (e.target.closest('.row')) return false;
    const last = tree.lastElementChild;
    if (!last?.querySelector('.row')) return false;
    return e.clientY > last.getBoundingClientRect().bottom;
  };

  pane.addEventListener('dragover', (e) => {
    if (!belowLastRow(e)) return tree.classList.remove('drop-end');
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tree.classList.add('drop-end');
  });
  pane.addEventListener('dragleave', (e) => {
    if (!pane.contains(e.relatedTarget)) tree.classList.remove('drop-end');
  });
  pane.addEventListener('drop', (e) => {
    if (!belowLastRow(e)) return;
    e.preventDefault();
    tree.classList.remove('drop-end');
    dropAtEnd();
  });
}

/* ---------- rendering ---------- */

function render() {
  renderStats();
  renderTree();
  document.querySelectorAll('#views button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  });
}

function renderStats() {
  const open = state.tasks.filter((t) => !CLOSED.has(t.status) && !isScheduled(t));
  const scheduled = state.tasks.filter(isScheduled);
  const overdue = open.filter((t) => t.due_date && daysUntil(t.due_date) < 0);
  const today = open.filter((t) => t.due_date && daysUntil(t.due_date) === 0);
  const week = open.filter((t) => t.due_date && daysUntil(t.due_date) >= 0 && daysUntil(t.due_date) <= 7);
  const gated = open.filter((t) => t.gated_by.length);
  const weekHours = week.reduce((s, t) => s + (t.estimate_hours || 0), 0);

  const stat = (label, value, cls = '') => h('div', { class: `stat ${cls}` }, h('b', { text: String(value) }), label);

  $('#stats').replaceChildren(...[
    stat('open', open.length),
    stat('due today', today.length, today.length ? 'warn' : ''),
    stat('overdue', overdue.length, overdue.length ? 'alert' : ''),
    stat('blocked', gated.length, gated.length ? 'warn' : ''),
    stat('hrs due this week', Math.round(weekHours * 10) / 10),
    scheduled.length ? stat('scheduled', scheduled.length) : null,
  ].filter(Boolean));
}

function renderTree() {
  const tree = $('#tree');
  const { ids, hitIds } = visibleIds();
  const roots = state.tasks.filter((t) => t.parent_id == null && ids.has(t.id));

  if (state.view === 'closed') {
    roots.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '') || b.id - a.id);
  } else {
    // Pinned tasks ride above the manual order.
    const pin = (t) => (t.pinned ? 0 : 1);
    roots.sort((a, b) => pin(a) - pin(b) || a.sort_order - b.sort_order || a.id - b.id);
  }

  lastRootId = roots.at(-1)?.id ?? null;

  if (!roots.length) {
    tree.replaceChildren(h('div', { class: 'empty-state' },
      h('h3', { text: state.query ? 'Nothing matches that search' : emptyHeadline() }),
      h('div', { text: state.query ? 'Try a different term, or switch to All open.' : 'Add one above, or hit Sync to pull from Jira and Outlook.' })));
    return;
  }
  tree.replaceChildren(...roots.map((t) => renderNode(t, ids, hitIds)));
}

function emptyHeadline() {
  return { closed: 'Nothing closed yet.', all: 'No open tasks.' }[state.view];
}

function renderNode(t, ids, hitIds) {
  const kids = childrenOf(t.id).filter((c) => ids.has(c.id));
  const isCollapsed = state.collapsed.has(t.id);
  const wrap = h('div');
  // A row mid-flourish is handed back rather than rebuilt: re-parenting keeps its
  // animations running, where a fresh row would restart the list underneath it.
  const row = completing.get(t.id)?.row
    ?? renderRow(t, kids.length, isCollapsed, hitIds.has(t.id));
  wrap.append(row);
  // The editor is a sibling of the row, not a child, so clicks inside it
  // never reach the row's collapse handler.
  if (state.expanded.has(t.id)) wrap.append(renderEditor(t, row));
  if (kids.length && !isCollapsed) {
    wrap.append(h('div', { class: 'children' }, ...kids.map((c) => renderNode(c, ids, hitIds))));
  }
  return wrap;
}

function renderRow(t, kidCount, isCollapsed, isHit) {
  const closed = CLOSED.has(t.status);
  const gated = t.gated_by.length > 0 && !closed;
  const isExpanded = state.expanded.has(t.id);
  const tags = t.tags ?? [];
  const cls = [
    'row',
    `src-${t.source_type}`,
    tags.length && 'tagged',
    closed && 'closed',
    gated && 'gated',
    isExpanded && 'expanded',
    dueClass(t) === 'overdue' && 'overdue',
    dueClass(t) === 'today' && 'due-today',
    !isHit && 'context',
  ].filter(Boolean).join(' ');

  const chips = [];
  if (t.pinned) chips.push(h('span', { class: 'chip pinned', text: '📌' }));
  if (t.recur_rule) chips.push(h('span', { class: 'chip recur', text: `🔁 ${describeRecur(t.recur_rule)}` }));
  if (t.due_date) chips.push(h('span', { class: `chip due ${dueClass(t)}`, text: `📅 ${formatDue(t.due_date)}` }));
  if (t.estimate_hours) chips.push(h('span', { class: 'chip est', text: `⏱ ${t.estimate_hours}h` }));
  if (kidCount) {
    const roll = Math.round(rollupHours(t) * 10) / 10;
    chips.push(h('span', { class: 'chip', text: `⊞ ${kidCount}${roll ? ` · ${roll}h` : ''}` }));
  }
  if (t.status !== 'todo') chips.push(h('span', { class: `chip st-${t.status}`, text: t.status }));
  if (t.priority === 'high' || t.priority === 'urgent') {
    chips.push(h('span', { class: `chip pri-${t.priority}`, text: t.priority }));
  }
  if (gated) {
    chips.push(h('span', { class: 'chip gate', text: `⛔ needs ${t.gated_by.map((id) => 'R-' + id).join(', ')}` }));
  }
  if (t.source_type !== 'brain') {
    const label = t.source_ref || t.source_type;
    const text = `${sourceIcon(t.source_type)} ${label}`;
    if (t.source_url) {
      const link = h('a', { class: `chip src-${t.source_type}`, href: t.source_url, target: '_blank',
                            rel: 'noopener noreferrer', text, onclick: (e) => e.stopPropagation() });
      // a link drags itself by default, which would hijack the row's drag
      link.draggable = false;
      chips.push(link);
    } else {
      chips.push(h('span', { class: `chip src-${t.source_type}`, text }));
    }
  }
  if (t.notes_log.length || t.notes) chips.push(h('span', { class: 'chip', text: `📝 ${t.notes_log.length || ''}`.trim() }));

  // The open editor shows the notes in full, so the teaser only earns its keep when closed.
  const preview = isExpanded ? '' : notePreview(t);

  const draggable = manualOrder();

  const row = h('div', {
    class: cls,
    // The whole line is the grab point; editing lives behind its own button.
    draggable,
    ondragstart: draggable ? (e) => {
      dragId = t.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `R-${t.id}`);
      e.currentTarget.classList.add('dragging');
    } : null,
    ondragend: draggable ? (e) => {
      dragId = null;
      e.currentTarget.classList.remove('dragging');
      clearDropMarks();
    } : null,
    ondragover: (e) => {
      if (dragId == null || dragId === t.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const box = e.currentTarget.getBoundingClientRect();
      const before = e.clientY < box.top + box.height / 2;
      e.currentTarget.classList.toggle('drop-before', before);
      e.currentTarget.classList.toggle('drop-after', !before);
    },
    // dragleave also fires when crossing into the row's own children — ignore those.
    ondragleave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      e.currentTarget.classList.remove('drop-before', 'drop-after');
    },
    ondrop: (e) => {
      e.preventDefault();
      const before = e.currentTarget.classList.contains('drop-before');
      clearDropMarks();
      dropOn(t.id, before);
    },
  },
    h('button', {
      class: `twisty${kidCount ? '' : ' hidden'}`,
      'aria-label': isCollapsed ? `Show subtasks of R-${t.id}` : `Hide subtasks of R-${t.id}`,
      text: isCollapsed ? '▶' : '▼',
      title: isCollapsed ? 'Expand' : 'Collapse',
      onclick: (e) => { e.stopPropagation(); toggleCollapse(t.id); },
    }),
    h('input', {
      type: 'checkbox', class: 'check', checked: closed,
      title: closed ? 'Reopen' : 'Mark done',
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => (e.target.checked
        ? completeTask(t, e.target.closest('.row'))
        : save(t.id, { status: 'todo' })),
    }),
    h('div', { class: 'row-main' },
      h('div', { class: 'title-line' },
        h('span', { class: 'rid', text: `R-${t.id}` }),
        h('span', {
          class: 'title', title: 'Click to edit',
          onclick: (e) => { e.stopPropagation(); editTitleInPlace(t, e.currentTarget); },
        }, ...titleNodes(t.title))),
      chips.length ? h('div', { class: 'chips' }, ...chips) : null,
      preview ? h('div', { class: 'note-preview', text: preview }) : null),
    h('div', { class: 'row-actions' },
      h('button', {
        class: `iconbtn edit${isExpanded ? ' on' : ''}`, text: '✎',
        title: isExpanded ? 'Close editor' : 'Edit',
        'aria-expanded': String(isExpanded),
        onclick: (e) => { e.stopPropagation(); toggleExpand(t.id); },
      }),
      h('button', { class: 'iconbtn', text: '↳', title: 'Add subtask',
        onclick: (e) => { e.stopPropagation(); addSubtask(t.id); } }),
      h('button', { class: 'iconbtn', text: '✕', title: 'Delete',
        onclick: (e) => { e.stopPropagation(); removeTask(t); } })),
    h('span', { class: 'edge l' }),
    h('span', { class: 'edge r' }),
  );

  // The first tag wins the row's wash; the source keeps the left stripe.
  if (tags.length) row.style.setProperty('--src-tint', tagColor(tags[0]));
  return row;
}

/* ---------- completing a task ---------- */

/** Tasks whose flourish is still playing, by id — see refresh() and renderNode(). */
const completing = new Map();

/**
 * The two sloped sides sweep inward, wiping the row out as they go, meet as a
 * check, then drift off while the row closes up and the list slides in behind it.
 * The write goes out first, so the flourish is only ever decoration. Tick as many
 * tasks as you like: each row plays out on its own, and the list settles once the
 * last of them is done.
 */
async function completeTask(t, row) {
  if (completing.has(t.id)) return;
  const written = api('PATCH', `/api/tasks/${t.id}`, { status: 'done' });
  // Finishing a task puts its editor away, which also hands the row back its
  // sloped sides — an expanded row squares off and hides them.
  if (state.expanded.delete(t.id)) {
    persistExpanded();
    row?.classList.remove('expanded');
    const editor = row?.nextElementSibling;
    if (editor?.classList.contains('roweditor')) editor.remove();
  }
  const play = row && !matchMedia('(prefers-reduced-motion: reduce)').matches
    ? playComplete(row)
    : Promise.resolve();
  completing.set(t.id, { play, row });
  try {
    await play;
    await written;
  } catch (err) {
    toast(err.message, true);
  } finally {
    completing.delete(t.id);
    await refresh();
  }
}

const WIPE = 720;   // sides travel to the middle, erasing the row
const FORM = 400;   // the V they make snaps into a check
const DRIFT = 640;  // check rises and fades as the row closes up

// Everything up to the first await is setup, so calling this starts the flourish.
async function playComplete(row) {
  const { width, height } = row.getBoundingClientRect();
  const slant = parseFloat(getComputedStyle(row).getPropertyValue('--slant')) || 10;
  const total = WIPE + FORM + DRIFT;
  const glide = 'cubic-bezier(.45, .05, .25, 1)';

  row.style.pointerEvents = 'none';
  row.draggable = false;

  // Half the row each, with a pixel of overlap so no seam shows in the middle.
  // A sloped leading edge leaves a wedge unerased at the top, so the panels keep
  // creeping while the check forms, which closes it just as the arms settle.
  for (const side of ['l', 'r']) {
    const wipe = h('span', { class: `wipe ${side}` });
    row.append(wipe);
    wipe.animate([
      { offset: 0, width: `${slant}px`, easing: glide },
      { offset: WIPE / (WIPE + FORM), width: `${width / 2 + 1}px` },
      { offset: 1, width: `${width / 2 + slant + 1}px` },
    ], { duration: WIPE + FORM, fill: 'forwards' });
  }
  row.animate({ borderTopColor: 'transparent', borderBottomColor: 'transparent' },
    { duration: WIPE, fill: 'forwards' });

  // Rotating about each line's lower tip keeps the two arms joined at the vertex.
  // The short arm is the left one, so the pair reads as a check and not a V.
  const travel = width / 2 - slant;
  // Easing lives on the keyframes, never on the animation as well: the sweep has to
  // match the wipe panels exactly or the line drifts off the edge it is erasing.
  const arm = (side, shift, check) => row.querySelector(`.edge.${side}`).animate([
    { offset: 0, transform: 'translateX(0)', easing: glide },
    {
      offset: WIPE / total, transform: `translateX(${shift}px)`, background: 'var(--check)',
      easing: 'cubic-bezier(.2, 1.5, .4, 1)',
    },
    {
      offset: (WIPE + FORM) / total, opacity: 1, background: 'var(--check)', easing: 'ease-out',
      transform: `translateX(${shift}px) ${check}`,
      filter: 'drop-shadow(0 0 6px var(--check-glow))',
    },
    {
      offset: 1, opacity: 0, background: 'var(--check)',
      transform: `translateY(-38px) translateX(${shift}px) ${check}`,
      filter: 'drop-shadow(0 0 6px var(--check-glow))',
    },
  ], { duration: total, fill: 'forwards' });

  const arms = [
    arm('l', travel, 'rotate(-32deg) scaleY(.5)'),
    arm('r', -travel, 'rotate(25deg) scaleY(1.15)'),
  ];

  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  await sleep(WIPE);
  // Nothing of the row shows through now, so let the check leave its silhouette
  // and drop the content that would otherwise spill out of a shrinking row.
  // The panels stay: they are what is holding the row's colour back.
  for (const kid of row.querySelectorAll(':scope > *:not(.edge):not(.wipe)')) {
    kid.style.visibility = 'hidden';
  }
  row.style.clipPath = 'none';

  await sleep(FORM);
  row.animate({
    height: [`${height}px`, '0px'],
    marginBottom: ['5px', '0px'],
    paddingTop: ['8px', '0px'],
    paddingBottom: ['8px', '0px'],
    borderTopWidth: ['1px', '0px'],
    borderBottomWidth: ['1px', '0px'],
  }, { duration: DRIFT, easing: glide, fill: 'forwards' });

  await Promise.all(arms.map((a) => a.finished));
}

/**
 * Swaps the title for a field in place: enter or clicking away keeps the edit,
 * escape throws it away. Editing is also how tags come and go, so a kept edit
 * goes through save() and lets the re-render recolour the row.
 */
function editTitleInPlace(t, titleEl) {
  const row = titleEl.closest('.row');
  if (row.querySelector('.title-input')) return;

  const input = h('input', { class: 'title-input', value: t.title, 'aria-label': `Title of R-${t.id}` });
  let settled = false;
  const finish = (keep) => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    input.replaceWith(titleEl);
    row.draggable = manualOrder();
    if (keep && next && next !== t.title) save(t.id, { title: next });
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    // the app-wide escape would blur the field, which counts as keeping it
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));

  // a draggable ancestor swallows drag-selection inside the field
  row.draggable = false;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

const sourceIcon = (s) => ({ jira: '🔷', outlook: '✉️', other: '🔗' }[s] || '🧠');

const RECUR_DAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

function describeRecur(rule) {
  const day = RECUR_DAYS.find(([k]) => rule === `weekly:${k}`);
  return day ? `weekly · ${day[1].slice(0, 3)}` : rule;
}

/** First line of the scratchpad, else the newest log entry — notes_log is newest first. */
function notePreview(t) {
  const raw = (t.notes || '').trim() || t.notes_log[0]?.body || '';
  const line = raw.split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/* ---------- inline editor ---------- */

/**
 * The editor lives in the row it belongs to, which makes redrawing the tree
 * destructive: it would pull the input out from under the cursor mid-word. So
 * discrete controls redraw (they reorder the list, and focus is leaving anyway)
 * while free text patches quietly and leaves the DOM alone.
 */
function renderEditor(t, row) {
  const patch = (field) => (e) => save(t.id, { [field]: e.target.value });
  const typed = (field) => debounce((e) => quietSave(t.id, { [field]: e.target.value }), 500);

  const opts = (list, current) => list.map((v) => h('option', { value: v, text: v, selected: v === current }));

  const otherTasks = state.tasks
    .filter((x) => x.id !== t.id)
    .sort((a, b) => a.id - b.id);

  const saveTitle = typed('title');
  const titleInput = h('input', {
    value: t.title,
    oninput: (e) => {
      row.querySelector('.title').replaceChildren(...titleNodes(e.target.value));
      saveTitle(e);
    },
    // Editing the title is how tags come and go. Saving on the way out settles their
    // colours, and beats the debounced save rather than racing a refresh against it.
    onchange: (e) => save(t.id, { title: e.target.value }),
  });

  const parts = [
    field('Title', titleInput),

    h('div', { class: 'grid3' },
      field('Status', h('select', { onchange: patch('status') }, ...opts(state.meta.statuses, t.status))),
      field('Priority', h('select', { onchange: patch('priority') }, ...opts(state.meta.priorities, t.priority))),
      field('Due date', h('input', { type: 'date', value: t.due_date || '', onchange: patch('due_date') }))),

    h('div', { class: 'grid3' },
      field('Estimate (hrs)', h('input', { type: 'number', step: '0.25', min: '0', value: t.estimate_hours ?? '', onchange: patch('estimate_hours') })),
      field('Repeat', h('select', { onchange: patch('recur_rule') },
        h('option', { value: '', text: '— does not repeat —', selected: !t.recur_rule }),
        ...RECUR_DAYS.map(([k, name]) => h('option', {
          value: `weekly:${k}`, text: `Weekly on ${name}`, selected: t.recur_rule === `weekly:${k}`,
        })))),
      field('Pin', h('label', { class: 'checkline' },
        h('input', {
          type: 'checkbox', checked: Boolean(t.pinned),
          onchange: (e) => save(t.id, { pinned: e.target.checked }),
        }),
        'Keep at top of the list'))),
    t.recur_rule ? h('div', { class: 'hint', text: 'Ticking this done closes it and opens a fresh copy for the next occurrence.' }) : null,

    field('Description', h('textarea', { value: t.description, rows: 3, oninput: typed('description') })),

    h('div', { class: 'section-title', text: 'Notes' }),
    field('Scratchpad', h('textarea', { value: t.notes, rows: 4, placeholder: 'Anything you want to remember about this one…', oninput: typed('notes') })),
    noteLog(t),

    h('div', { class: 'section-title', text: 'Source' }),
    h('div', { class: 'grid2' },
      field('Type', h('select', { onchange: patch('source_type') }, ...opts(state.meta.sources, t.source_type))),
      field('Reference', h('input', { value: t.source_ref || '', placeholder: 'QAD-1017 / email subject', oninput: typed('source_ref') }))),
    field('Link', h('input', { value: t.source_url || '', placeholder: 'https://… or ms-outlook://…', oninput: typed('source_url') })),
    t.external_status ? h('div', { class: 'hint', text: `Remote status: ${t.external_status}${t.synced_at ? ` · synced ${new Date(t.synced_at).toLocaleString()}` : ''}` }) : null,

    h('div', { class: 'section-title', text: 'Hierarchy' }),
    field('Parent task',
      h('select', { onchange: (e) => save(t.id, { parent_id: e.target.value || null }) },
        h('option', { value: '', text: '— none (top level) —', selected: t.parent_id == null }),
        ...otherTasks.map((x) => h('option', { value: String(x.id), text: `R-${x.id} · ${x.title.slice(0, 50)}`, selected: x.id === t.parent_id })))),
    h('button', { class: 'btn sm', text: '↳ Add subtask', onclick: () => addSubtask(t.id) }),

    h('div', { class: 'section-title', text: 'Dependencies' }),
    depSection(t, otherTasks),

    h('div', { class: 'section-title', text: '' }),
    h('div', { class: 'roweditor-foot' },
      h('div', { class: 'hint', text: `Created ${new Date(t.created_at).toLocaleString()}${t.completed_at ? ` · closed ${new Date(t.completed_at).toLocaleString()}` : ''}` }),
      h('div', { style: 'display:flex; gap:6px' },
        h('button', { class: 'btn danger sm', text: 'Delete task', onclick: () => removeTask(t) }),
        h('button', { class: 'btn sm', text: 'Collapse', onclick: () => toggleExpand(t.id) }))),
  ];
  return h('div', { class: 'roweditor' }, ...parts.filter(Boolean));
}

function field(label, control) {
  return h('div', { class: 'field' }, h('label', { text: label }), control);
}

function depSection(t, otherTasks) {
  const box = h('div');
  const list = h('div', { class: 'deplist' });

  for (const id of t.blocked_by) {
    const dep = state.byId.get(id);
    if (!dep) continue;
    const open = !CLOSED.has(dep.status);
    list.append(h('div', { class: `depitem${open ? ' open' : ''}` },
      h('span', { text: open ? '⛔' : '✓' }),
      h('span', { class: 'grow', text: `R-${dep.id} · ${dep.title}` }),
      h('button', { class: 'iconbtn', text: '✕', title: 'Remove dependency',
        onclick: async () => { await api('DELETE', `/api/tasks/${t.id}/deps/${dep.id}`); refresh(); } })));
  }
  if (!t.blocked_by.length) list.append(h('div', { class: 'hint', text: 'Nothing is blocking this task.' }));
  box.append(h('label', { class: '', text: '' }), list);

  const picker = h('select', {},
    h('option', { value: '', text: '+ blocked by…' }),
    ...otherTasks.filter((x) => !t.blocked_by.includes(x.id))
      .map((x) => h('option', { value: String(x.id), text: `R-${x.id} · ${x.title.slice(0, 50)}` })));
  picker.addEventListener('change', async (e) => {
    if (!e.target.value) return;
    try {
      await api('POST', `/api/tasks/${t.id}/deps`, { depends_on_id: Number(e.target.value) });
      await refresh();
    } catch (err) { toast(err.message, true); e.target.value = ''; }
  });
  box.append(field('', picker));

  if (t.blocking.length) {
    box.append(h('div', { class: 'hint', text: `Blocks: ${t.blocking.map((id) => `R-${id}`).join(', ')}` }));
  }
  return box;
}

function noteLog(t) {
  const box = h('div');
  const input = h('textarea', { rows: 2, placeholder: 'Log progress…  (⌘↵ to save)' });
  const add = async () => {
    const body = input.value.trim();
    if (!body) return;
    await api('POST', `/api/tasks/${t.id}/notes`, { body });
    input.value = '';
    await refresh();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
  });
  box.append(field('Progress log', input), h('button', { class: 'btn sm', text: '+ Add entry', onclick: add }));

  const log = h('div', { class: 'notelog' });
  for (const n of t.notes_log) {
    log.append(h('div', { class: 'noteitem' },
      h('button', {
        class: 'iconbtn del', text: '✕', title: 'Delete entry',
        onclick: async () => { await api('DELETE', `/api/notes/${n.id}`); refresh(); },
      }),
      h('time', { text: new Date(n.created_at).toLocaleString() }),
      h('div', { class: 'body', text: n.body })));
  }
  box.append(log);
  return box;
}

/* ---------- actions ---------- */

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

async function save(id, patch) {
  try {
    await api('PATCH', `/api/tasks/${id}`, patch);
    await refresh();
  } catch (err) { toast(err.message, true); refresh(); }
}

/** Saves without redrawing, so an open editor keeps its focus and caret. */
async function quietSave(id, patch) {
  try {
    await api('PATCH', `/api/tasks/${id}`, patch);
    Object.assign(state.byId.get(id) ?? {}, patch);
  } catch (err) { toast(err.message, true); }
}

function toggleExpand(id) {
  state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
  persistExpanded();
  renderTree();
}

function collapseAll() {
  if (!state.expanded.size) return;
  state.expanded.clear();
  persistExpanded();
  renderTree();
}

function persistExpanded() {
  localStorage.setItem('rodeo.expanded', JSON.stringify([...state.expanded]));
}

function toggleCollapse(id) {
  state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
  localStorage.setItem('rodeo.collapsed', JSON.stringify([...state.collapsed]));
  renderTree();
}

async function addSubtask(parentId) {
  const title = prompt('New subtask under R-' + parentId);
  if (!title?.trim()) return;
  try {
    await api('POST', '/api/tasks', { ...parseQuickAdd(title), parent_id: parentId });
    state.collapsed.delete(parentId);
    await refresh();
  } catch (err) { toast(err.message, true); }
}

async function removeTask(t) {
  const kids = childrenOf(t.id);
  const warning = kids.length ? `\n\nThis also deletes ${kids.length} subtask${kids.length > 1 ? 's' : ''} beneath it.` : '';
  if (!confirm(`Delete R-${t.id} "${t.title}"?${warning}`)) return;
  await api('DELETE', `/api/tasks/${t.id}`);
  for (const id of subtree(t).map((x) => x.id)) state.expanded.delete(id);
  persistExpanded();
  await refresh();
}

/* ---------- settings / sync ---------- */

function openModal(...content) {
  const root = $('#modal-root');
  const close = () => root.replaceChildren();
  const backdrop = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal' }, ...content));
  root.replaceChildren(backdrop);
  return close;
}

function openSettings() {
  const rows = state.integrations.map((i) =>
    h('div', { class: 'intg' },
      h('span', { class: `dot ${i.configured ? 'on' : i.enabled ? 'err' : 'off'}` }),
      h('b', { text: i.label }),
      h('span', { class: 'hint', text: i.detail }),
      h('span', { class: 'spacer', style: 'flex:1' }),
      i.id === 'outlook' && i.enabled
        ? h('button', { class: 'btn sm', text: 'Connect', onclick: connectOutlook })
        : null,
      i.configured
        ? h('button', { class: 'btn sm', text: 'Sync', onclick: () => runSync(i.id) })
        : null));

  openModal(
    h('h3', { text: 'Integrations' }),
    ...rows,
    h('div', { class: 'section-title', text: 'Setup' }),
    h('div', { class: 'hint' },
      'Edit ', h('code', { text: 'config.json' }), ' in the rodeo folder (copy ',
      h('code', { text: 'config.example.json' }), ' to start), then restart the server. ',
      'See README.md for the Jira token and Entra app-registration steps.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', text: 'Close', onclick: () => $('#modal-root').replaceChildren() })));
}

function openTags() {
  const body = state.tags.length
    ? h('div', { class: 'taglist' }, ...state.tags.map((tag) => {
      const swatch = h('span', { class: 'tagname', text: `#${tag.name}` });
      swatch.style.setProperty('--tag', tag.color);
      return h('div', { class: 'tagrow' },
        h('input', {
          type: 'color', value: tag.color, 'aria-label': `Colour for #${tag.name}`,
          onchange: async (e) => {
            try {
              state.tags = await api('PUT', `/api/tags/${tag.name}`, { color: e.target.value });
              swatch.style.setProperty('--tag', e.target.value);
              renderTree();
            } catch (err) { toast(err.message, true); }
          },
        }),
        swatch,
        h('span', { class: 'spacer', style: 'flex:1' }),
        h('span', { class: 'count', text: `${tag.count} task${tag.count === 1 ? '' : 's'}` }));
    }))
    : h('div', { class: 'hint', text: 'No tags yet. Put one in a task title, like “Fix totals #ecrash”.' });

  openModal(
    h('h3', { text: 'Tags' }),
    body,
    h('div', { class: 'hint' },
      'A tag is any ', h('code', { text: '#word' }), ' in a task title. The row takes the colour of its ',
      'first tag, and the stripe down the left still shows where the task came from. ',
      'To drop a tag, edit the title and delete it.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', text: 'Close', onclick: () => $('#modal-root').replaceChildren() })));
}

async function connectOutlook() {
  try {
    const dc = await api('POST', '/api/integrations/outlook/login');
    window.open(dc.authorize_url, '_blank', 'noopener');
    let stopped = false;
    const close = openModal(
      h('h3', { text: 'Connect Outlook' }),
      h('div', { text: 'A Microsoft sign-in tab should have opened. Approve access there, then come back here.' }),
      h('a', { href: dc.authorize_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open the sign-in page again' }),
      h('div', { class: 'hint', id: 'dc-status', text: 'Waiting for you to finish signing in…' }),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', text: 'Cancel', onclick: () => { stopped = true; $('#modal-root').replaceChildren(); } })));

    const deadline = Date.now() + 600_000;
    const poll = async () => {
      if (stopped) return;
      if (Date.now() > deadline) { $('#dc-status').textContent = 'Sign-in timed out — try again.'; return; }
      try {
        const r = await api('POST', '/api/integrations/outlook/poll');
        if (r.status === 'complete') {
          close();
          toast(`Outlook connected as ${r.account || 'your account'}`);
          await refresh();
          return runSync('outlook');
        }
      } catch (err) {
        $('#dc-status').textContent = err.message;
        return;
      }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  } catch (err) { toast(err.message, true); }
}

async function runSync(only) {
  const btn = $('#btn-sync');
  btn.disabled = true;
  btn.textContent = '⟳ Syncing…';
  try {
    const results = await api('POST', '/api/sync', only ? { only } : {});
    await refresh();
    const parts = results.map((r) => {
      if (r.error) return `${r.provider}: ${r.error}`;
      if (r.skipped) return `${r.provider}: ${r.reason}`;
      return `${r.provider}: +${r.created} new, ${r.updated} updated${r.closed ? `, ${r.closed} closed` : ''}`;
    });
    const failed = results.some((r) => r.error);
    toast(parts.join(' · ') || 'Nothing configured to sync', failed);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Sync';
  }
}

/* ---------- daily recap ---------- */

/** Timestamps are stored as UTC ISO strings, but a day means a day where you live. */
const localDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA') : null);

const timeOfDay = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * Two questions, one answer: what got closed, and what got written down. The log
 * entries matter because a day of real work often ends with nothing ticked off.
 */
function recapFor(day) {
  const completed = state.tasks
    .filter((t) => t.status === 'done' && localDay(t.completed_at) === day)
    .sort((a, b) => a.completed_at.localeCompare(b.completed_at));

  const logged = state.tasks
    .map((t) => ({
      task: t,
      entries: t.notes_log
        .filter((n) => localDay(n.created_at) === day)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    }))
    .filter((x) => x.entries.length)
    .sort((a, b) => a.entries[0].created_at.localeCompare(b.entries[0].created_at));

  const hours = completed.reduce((s, t) => s + (t.estimate_hours || 0), 0);
  const notes = logged.reduce((s, x) => s + x.entries.length, 0);
  return { completed, logged, hours, notes };
}

function recapChips(t) {
  const chips = [];
  if (t.estimate_hours) chips.push(h('span', { class: 'chip est', text: `⏱ ${t.estimate_hours}h` }));
  if (t.source_type !== 'brain') {
    const label = t.source_ref || t.source_type;
    chips.push(t.source_url
      ? h('a', { class: `chip src-${t.source_type}`, href: t.source_url, target: '_blank', rel: 'noopener noreferrer',
                 text: `${sourceIcon(t.source_type)} ${label}` })
      : h('span', { class: `chip src-${t.source_type}`, text: `${sourceIcon(t.source_type)} ${label}` }));
  }
  return chips.length ? h('div', { class: 'chips' }, ...chips) : null;
}

function recapHeading(day) {
  if (day === todayStr()) return 'What I did today';
  const when = parseDate(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return `What I did on ${when}`;
}

const RSVP = {
  accepted: { label: 'accepted', class: 'accepted' },
  tentativelyAccepted: { label: 'tentative', class: 'tentative' },
  organizer: { label: 'you organized', class: 'organizer' },
  none: { label: 'no reply', class: 'none' },
};

function meetingRow(m) {
  const rsvp = RSVP[m.response] ?? RSVP.none;
  return h('div', { class: 'recap-item' },
    h('time', { text: m.all_day ? 'all day' : timeOfDay(m.start) }),
    h('div', { class: 'grow' },
      h('div', {}, m.url
        ? h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer', text: m.subject })
        : m.subject),
      h('div', { class: 'chips' },
        h('span', { class: `chip rsvp-${rsvp.class}`, text: rsvp.label }),
        m.organizer && m.response !== 'organizer'
          ? h('span', { class: 'chip', text: m.organizer })
          : null)));
}

function recapSummary({ completed, meetings, hours, notes }) {
  return [
    `${completed} task${completed === 1 ? '' : 's'} closed`,
    meetings ? `${meetings} meeting${meetings === 1 ? '' : 's'}` : null,
    hours ? `${Math.round(hours * 10) / 10}h estimated` : null,
    notes ? `${notes} note${notes === 1 ? '' : 's'} logged` : null,
  ].filter(Boolean).join(' · ');
}

/** Only the newest recap paints — picking a new date mid-fetch shouldn't race. */
let recapRequest = 0;

function openRecap(day, { pickDate = false } = {}) {
  const { completed, logged, hours, notes } = recapFor(day);

  const dateInput = h('input', {
    type: 'date', value: day, max: todayStr(), 'aria-label': 'Recap date',
    onchange: (e) => { if (e.target.value) openRecap(e.target.value); },
  });

  const summaryEl = h('div', {
    class: 'hint',
    text: recapSummary({ completed: completed.length, meetings: 0, hours, notes }),
  });
  // Both of these fill in once Outlook answers: until then rodeo doesn't know
  // whether the day was empty, so it says nothing rather than something wrong.
  const meetingsBox = h('div', { class: 'recap-meetings' },
    h('div', { class: 'hint', text: 'Checking Outlook…' }));
  const emptyBox = h('div', {});

  const parts = [
    h('div', { class: 'recap-head' }, h('h3', { text: recapHeading(day) }), dateInput),
    summaryEl,
    emptyBox,
  ];

  if (completed.length) {
    parts.push(h('div', { class: 'section-title', text: 'Completed' }));
    parts.push(h('div', { class: 'recap-list' }, ...completed.map((t) => h('div', { class: 'recap-item' },
      h('time', { text: timeOfDay(t.completed_at) }),
      h('div', { class: 'grow' },
        h('div', {}, h('span', { class: 'rid', text: `R-${t.id}` }), ' ', t.title),
        recapChips(t))))));
  }

  parts.push(meetingsBox);

  if (logged.length) {
    parts.push(h('div', { class: 'section-title', text: 'Logged' }));
    parts.push(h('div', { class: 'recap-list' }, ...logged.map(({ task, entries }) => h('div', { class: 'recap-group' },
      h('div', { class: 'recap-group-head' },
        h('span', { class: 'rid', text: `R-${task.id}` }),
        h('span', { class: 'grow', text: task.title }),
        CLOSED.has(task.status) ? h('span', { class: `chip st-${task.status}`, text: task.status }) : null),
      ...entries.map((n) => h('div', { class: 'noteitem' },
        h('time', { text: timeOfDay(n.created_at) }),
        h('div', { class: 'body', text: n.body })))))));
  }

  parts.push(h('div', { class: 'modal-actions' },
    h('button', { class: 'btn', text: 'Close', onclick: () => $('#modal-root').replaceChildren() })));

  openModal(...parts.filter(Boolean));
  $('#modal-root .modal').classList.add('wide');
  if (pickDate) {
    dateInput.focus();
    try { dateInput.showPicker?.(); } catch { /* picker needs user activation; focus is enough */ }
  }

  const paint = ({ available, meetings = [], detail }) => {
    meetingsBox.replaceChildren(...(available
      ? meetings.length
        ? [h('div', { class: 'section-title', text: 'Meetings' }),
           h('div', { class: 'recap-list' }, ...meetings.map(meetingRow))]
        : []
      : [h('div', { class: 'hint', text: `Meetings unavailable — ${detail}` })]));

    summaryEl.textContent = recapSummary({
      completed: completed.length, meetings: meetings.length, hours, notes,
    });

    if (completed.length || logged.length || meetings.length) {
      emptyBox.replaceChildren();
      return;
    }
    // Rodeo can only call a day empty if it could see the calendar. Without that
    // the old wording stands, since "no meetings" would be a guess.
    emptyBox.replaceChildren(h('div', {
      class: available ? 'recap-empty fired' : 'recap-empty',
      text: available
        ? 'Nothing as far as I know... Maybe you got fired 🔥'
        : 'Nothing closed and nothing logged on this day.',
    }));
  };

  const request = ++recapRequest;
  api('GET', `/api/recap/meetings?day=${day}`)
    .catch((err) => ({ available: false, detail: err.message }))
    .then((data) => { if (request === recapRequest) paint(data); });
}

/* ---------- wiring ---------- */

bindEndZone();

async function quickAdd(place) {
  const input = $('#quickadd-input');
  const parsed = parseQuickAdd(input.value);
  if (!parsed.title) return;
  try {
    await api('POST', '/api/tasks', { ...parsed, place });
    input.value = '';
    await refresh();
  } catch (err) { toast(err.message, true); }
}

// Hold shift — on ↵ or on the button — to send the new task to the bottom instead.
$('#quickadd').addEventListener('submit', (e) => { e.preventDefault(); quickAdd('top'); });
$('#quickadd-btn').addEventListener('click', (e) => {
  e.preventDefault();
  quickAdd(e.shiftKey ? 'bottom' : 'top');
});
$('#quickadd-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  quickAdd(e.shiftKey ? 'bottom' : 'top');
});

$('#views').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  state.view = btn.dataset.view;
  localStorage.setItem('rodeo.view', state.view);
  render();
});

$('#search').addEventListener('input', debounce((e) => {
  state.query = e.target.value;
  renderTree();
}, 150));

$('#btn-recap-today').addEventListener('click', () => openRecap(todayStr()));
$('#btn-recap-day').addEventListener('click', () => openRecap(todayStr(), { pickDate: true }));

$('#btn-tags').addEventListener('click', openTags);
$('#btn-sync').addEventListener('click', () => runSync());
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-new').addEventListener('click', () => $('#quickadd-input').focus());

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape') {
    if ($('#modal-root').firstChild) $('#modal-root').replaceChildren();
    else if (typing) document.activeElement.blur();
    else collapseAll();
    return;
  }
  if (typing) return;
  if (e.key === 'n') { e.preventDefault(); $('#quickadd-input').focus(); }
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  if (e.key === 's') runSync();
});

refresh().catch((err) => toast(err.message, true));
