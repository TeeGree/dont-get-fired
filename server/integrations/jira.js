/**
 * Jira provider — supports both Jira Cloud (email + API token, REST v3)
 * and Jira Server / Data Center (Personal Access Token, REST v2).
 */

export const id = 'jira';
export const label = 'Jira';

const isCloud = (cfg) => cfg.flavor !== 'server';

export function configured(cfg) {
  if (!cfg?.enabled || !cfg.baseUrl) return false;
  return isCloud(cfg) ? Boolean(cfg.email && cfg.apiToken) : Boolean(cfg.personalAccessToken);
}

export function describe(cfg) {
  if (!cfg?.enabled) return 'disabled';
  if (!cfg.baseUrl) return 'no baseUrl set';
  if (!configured(cfg)) {
    return isCloud(cfg) ? 'missing email or apiToken' : 'missing personalAccessToken';
  }
  return `${cfg.baseUrl} (${isCloud(cfg) ? 'cloud' : 'server'})`;
}

function authHeader(cfg) {
  if (isCloud(cfg)) {
    return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  }
  return `Bearer ${cfg.personalAccessToken}`;
}

/** Jira Cloud descriptions are Atlassian Document Format; flatten to plain text. */
function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const inner = adfToText(node.content);
  return ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type)
    ? inner + '\n'
    : inner;
}

function secondsToHours(sec) {
  return typeof sec === 'number' && sec > 0 ? Math.round((sec / 3600) * 100) / 100 : null;
}

export async function fetchItems(cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const api = isCloud(cfg) ? '3' : '2';
  const fields = ['summary', 'description', 'duedate', 'status', 'priority', 'timeoriginalestimate', 'aggregatetimeoriginalestimate'];

  // Jira Cloud replaced /search with /search/jql in 2025; Server/DC still uses /search.
  const paths = isCloud(cfg)
    ? [`/rest/api/${api}/search/jql`, `/rest/api/${api}/search`]
    : [`/rest/api/${api}/search`];

  const search = async (path) => {
    const url = new URL(base + path);
    url.searchParams.set('jql', cfg.jql);
    url.searchParams.set('maxResults', String(cfg.maxResults ?? 50));
    url.searchParams.set('fields', fields.join(','));
    return fetch(url, { headers: { Authorization: authHeader(cfg), Accept: 'application/json' } });
  };

  let res = await search(paths[0]);
  if (!res.ok && [404, 410].includes(res.status) && paths[1]) res = await search(paths[1]);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  const data = await res.json();

  // Jira Cloud answers an unauthenticated search with 200 and zero issues instead
  // of 401, so an empty result can't be distinguished from a bad token on its own.
  if (!(data.issues ?? []).length) await assertCredentials(cfg, base, api);

  return (data.issues ?? []).map((issue) => {
    const f = issue.fields ?? {};
    const category = f.status?.statusCategory?.key; // 'new' | 'indeterminate' | 'done'
    return {
      external_id: issue.key,
      title: f.summary || issue.key,
      description: adfToText(f.description).trim().slice(0, 4000),
      source_ref: issue.key,
      source_url: `${base}/browse/${issue.key}`,
      external_status: f.status?.name ?? null,
      due_date: f.duedate || null,
      estimate_hours: secondsToHours(f.timeoriginalestimate ?? f.aggregatetimeoriginalestimate),
      priority: mapPriority(f.priority?.name),
      closed: category === 'done',
    };
  });
}

async function assertCredentials(cfg, base, api) {
  const res = await fetch(`${base}/rest/api/${api}/myself`, {
    headers: { Authorization: authHeader(cfg), Accept: 'application/json' },
  });
  if (res.ok) return;
  const detail = isCloud(cfg) ? 'check email and apiToken' : 'check personalAccessToken';
  throw new Error(`Jira rejected the credentials (${res.status} ${res.statusText}) — ${detail}`);
}

function mapPriority(name) {
  switch ((name || '').toLowerCase()) {
    case 'highest': case 'blocker': case 'critical': return 'urgent';
    case 'high': case 'major': return 'high';
    case 'low': case 'lowest': case 'minor': case 'trivial': return 'low';
    default: return null;
  }
}
