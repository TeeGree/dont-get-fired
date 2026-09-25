import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './db.js';

const CONFIG_PATH = process.env.RODEO_CONFIG || join(ROOT, 'config.json');

const DEFAULTS = {
  port: 4444,
  jira: {
    enabled: false,
    // "cloud" -> https://your-team.atlassian.net  |  "server" -> https://jira.yourcompany.com
    flavor: 'cloud',
    baseUrl: '',
    // cloud: your Atlassian account email + an API token from id.atlassian.com
    email: '',
    apiToken: '',
    // server/data-center: a Personal Access Token (leave email blank)
    personalAccessToken: '',
    jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC',
    maxResults: 50,
    // when the Jira issue closes, close the matching rodeo task too
    mirrorClosed: true,
  },
  outlook: {
    enabled: false,
    // from an Entra ID (Azure AD) app registration — a public client, no secret
    clientId: '',
    tenantId: 'common',
    // register this exact string in Entra under "Mobile and desktop applications"
    redirectUri: 'http://localhost:4444/api/integrations/outlook/callback',
    scopes: ['offline_access', 'Mail.Read', 'Tasks.Read', 'User.Read', 'Calendars.Read'],
    // pull flagged email into rodeo
    flaggedMail: true,
    // pull Microsoft To Do tasks into rodeo
    todo: false,
    maxResults: 50,
    mirrorClosed: true,
  },
  // A second mailbox, from its own app registration in its own tenant. It is the
  // same provider with a narrower job: only flagged mail in one category becomes
  // a task, and its unread mail is read live for the strip above the list.
  outlook2: {
    enabled: false,
    // what to call this account in the ⚙ panel
    label: 'Outlook (second account)',
    clientId: '',
    tenantId: 'common',
    redirectUri: 'http://localhost:4444/api/integrations/outlook2/callback',
    scopes: ['offline_access', 'Mail.Read', 'User.Read'],
    flaggedMail: true,
    // only flagged mail carrying this category becomes a task. Outlook categories
    // are case-sensitive, so this has to match the one in Outlook exactly.
    // Empty or null means every flagged mail, the way the first account behaves.
    flaggedCategory: 'Taylor',
    // the unread strip. 'inbox' keeps Junk and filed mail out; 'all' sweeps the lot
    unread: true,
    unreadFolder: 'inbox',
    unreadMax: 100,
    // no calendar: the recap reads the work account
    todo: false,
    maxResults: 50,
    mirrorClosed: true,
  },
};

function deepMerge(base, override) {
  if (override == null || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out && typeof out[k] === 'object' && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULTS);
  try {
    return deepMerge(structuredClone(DEFAULTS), JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    console.error(`[rodeo] config.json is not valid JSON — using defaults (${err.message})`);
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(next) {
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** Config with every secret blanked out — safe to hand to the browser. */
export function redactedConfig() {
  const c = loadConfig();
  const mask = (v) => (v ? '••••••••' : '');
  return {
    ...c,
    jira: { ...c.jira, apiToken: mask(c.jira.apiToken), personalAccessToken: mask(c.jira.personalAccessToken) },
  };
}

export { CONFIG_PATH, DEFAULTS };
