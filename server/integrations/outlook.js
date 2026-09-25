/**
 * Outlook provider — Microsoft Graph.
 *
 * Auth is the OAuth authorization-code flow with PKCE: rodeo opens the Microsoft
 * sign-in page and catches the redirect back on its own loopback port. Needs an
 * Entra ID (Azure AD) app registration with the redirect URI below listed under
 * "Mobile and desktop applications" — no client secret, and no "Allow public
 * client flows", which exists for device code and is worth leaving off.
 * Tokens are cached in data/<id>-token.json and refreshed automatically.
 *
 * rodeo runs two of these. Same code, different config, separate app
 * registrations, separate token caches:
 *
 *   outlook   the work account. Every flagged mail becomes a task, and the
 *             daily recap reads its calendar.
 *   outlook2  a second mailbox that works differently: only flagged mail
 *             carrying one category ("Taylor") becomes a task, and its unread
 *             mail is read live for the strip above the task list — never
 *             synced, never stored, because an inbox is a reading list and
 *             not a backlog.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../db.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const authority = (cfg) => `https://login.microsoftonline.com/${cfg.tenantId || 'common'}/oauth2/v2.0`;

/**
 * One mailbox. Everything that used to be module state — the token path, the
 * in-flight sign-in — lives in here instead, so two accounts can be mid-anything
 * at once without treading on each other.
 *
 * `requiredScopes` are the ones rodeo asks for whatever config.json says; see
 * scopeList below for why.
 */
export function createOutlook({ id, label, requiredScopes, sourceType = id }) {
  const TOKEN_PATH = join(ROOT, 'data', `${id}-token.json`);
  const CALLBACK_PATH = `/api/integrations/${id}/callback`;

  function configured(cfg) {
    return Boolean(cfg?.enabled && cfg.clientId);
  }

  function describe(cfg) {
    if (!cfg?.enabled) return 'disabled';
    if (!cfg.clientId) return 'missing clientId (Entra app registration)';
    if (!hasToken()) return 'not signed in — run Connect';
    const who = `signed in as ${readToken().account || 'unknown account'}`;
    return cfg.flaggedCategory ? `${who} · flagged “${cfg.flaggedCategory}” only` : who;
  }

  /* ---------- token cache ---------- */

  function readToken() {
    if (!existsSync(TOKEN_PATH)) return null;
    try { return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
  }
  function writeToken(tok) {
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(TOKEN_PATH, JSON.stringify(tok, null, 2), { mode: 0o600 });
  }
  function hasToken() { return Boolean(readToken()?.refresh_token); }
  function signOut() {
    if (existsSync(TOKEN_PATH)) writeFileSync(TOKEN_PATH, '{}', { mode: 0o600 });
    return { signed_out: true };
  }

  function store(cfg, payload) {
    const account = decodeAccount(payload.access_token) || readToken()?.account || null;
    writeToken({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || readToken()?.refresh_token,
      expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000 - 60_000,
      scope: payload.scope || null,
      account,
    });
    return payload;
  }

  /* ---------- authorization code flow with PKCE ---------- */

  /** Must match the redirect URI registered in Entra, character for character. */
  const redirectUri = (cfg) => cfg.redirectUri || `http://localhost:4444${CALLBACK_PATH}`;

  /**
   * A config written before a feature landed can pin a scopes list that leaves
   * one out, and a token missing it fails only later, as a 403 from Graph. Ask
   * for what this account actually needs regardless of what it says.
   */
  const scopeList = (cfg) => [...new Set([...(cfg.scopes || []), ...requiredScopes])];
  const scopeString = (cfg) => scopeList(cfg).join(' ');

  /**
   * Entra hands back the scopes it actually granted, which is not always the set
   * that was asked for. A cached token minted before a scope was added stays valid
   * for an hour, so without this check adding one looks like a 403 from Graph.
   * Tokens cached by older versions have no record of their scopes: refresh those.
   */
  function coversScopes(tok, cfg) {
    if (!tok.scope) return false;
    const granted = tok.scope.toLowerCase();
    return scopeList(cfg)
      .filter((s) => s !== 'offline_access') // consent-only; never appears in the grant
      .every((s) => granted.includes(s.toLowerCase()));
  }

  /** One sign-in at a time per account; the verifier never leaves this process. */
  let pending = null;

  function startLogin(cfg) {
    if (!cfg.clientId) throw new Error(`Set ${id}.clientId in config.json first`);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    pending = { verifier, state, status: 'pending' };

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: redirectUri(cfg),
      response_mode: 'query',
      scope: scopeString(cfg),
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      // Two accounts share this browser. Without the prompt the second sign-in
      // would sail through on whoever Microsoft remembers, and rodeo would end up
      // holding two tokens for one mailbox.
      prompt: 'select_account',
    });
    return { authorize_url: `${authority(cfg)}/authorize?${params}`, redirect_uri: redirectUri(cfg) };
  }

  /** Entra redirects the browser here with ?code=…&state=…; returns a page for that tab. */
  async function handleCallback(cfg, params) {
    const fail = (msg) => {
      if (pending) { pending.status = 'error'; pending.error = msg; }
      return page('Sign-in failed', msg);
    };
    if (pending?.status !== 'pending') return page('Nothing to do', `No sign-in is in progress for ${label}. Click Connect in rodeo first.`);
    if (params.get('error')) return fail(params.get('error_description') || params.get('error'));
    if (params.get('state') !== pending.state) return fail('State did not match — rodeo did not start this sign-in.');
    const code = params.get('code');
    if (!code) return fail('Microsoft did not return an authorization code.');

    const res = await fetch(`${authority(cfg)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        code,
        redirect_uri: redirectUri(cfg),
        code_verifier: pending.verifier,
        scope: scopeString(cfg),
      }),
    });
    const data = await res.json();
    if (!res.ok) return fail(data.error_description || data.error || `token exchange failed (${res.status})`);

    store(cfg, data);
    pending = { status: 'complete', account: readToken()?.account };
    return page('Connected', `rodeo is signed in to ${label} as ${pending.account || 'your account'}. You can close this tab.`);
  }

  /** Poll once. Returns {status:'pending'|'complete'} so the UI can drive the loop. */
  function pollLogin() {
    if (!pending) return { status: 'idle' };
    if (pending.status === 'error') {
      const { error } = pending;
      pending = null;
      throw new Error(error);
    }
    if (pending.status === 'complete') return { status: 'complete', account: pending.account };
    return { status: 'pending' };
  }

  async function accessToken(cfg) {
    const tok = readToken();
    if (!tok?.refresh_token) throw new Error(`${label} is not connected — click Connect to sign in`);
    const cached = tok.access_token && tok.expires_at > Date.now() ? tok.access_token : null;
    if (cached && coversScopes(tok, cfg)) return cached;

    const res = await fetch(`${authority(cfg)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cfg.clientId,
        refresh_token: tok.refresh_token,
        scope: scopeString(cfg),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      // A refresh asking for a newly added scope fails until you consent to it
      // interactively. The cached token still covers what it was granted, so mail
      // and tasks carry on; only the calendar call ends up failing, and it says why.
      if (cached) return cached;
      const detail = data.error_description || data.error;
      const hint = /AADSTS65001|consent|invalid_grant|interaction_required/i.test(detail || '')
        ? ' — click Connect to sign in again'
        : '';
      throw new Error(`${label} token refresh failed: ${detail}${hint}`);
    }
    store(cfg, data);
    return data.access_token;
  }

  async function graph(cfg, path, headers = {}) {
    const token = await accessToken(cfg);
    const res = await fetch(GRAPH + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Graph ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    }
    return res.json();
  }

  /* ---------- fetch ---------- */

  async function mailQuery(cfg, filter, top, orderby, plainer) {
    const url = (f) =>
      `/me/messages?$filter=${encodeURIComponent(f)}&$select=${MAIL_SELECT}&$top=${top}`;
    try {
      return (await graph(cfg, `${url(filter)}&$orderby=${encodeURIComponent(orderby)}`)).value ?? [];
    } catch (err) {
      // Graph rejects some filter+sort pairings outright; the unsorted page still works.
      if (!rejectedQuery(err)) throw err;
      try {
        return (await graph(cfg, url(filter))).value ?? [];
      } catch (err2) {
        // And some mailboxes won't take categories/any() alongside the flag test at
        // all. Fall back to the filter Graph always accepts — fetchItems sieves the
        // categories itself anyway, so the answer is the same, just a bigger page.
        if (!plainer || !rejectedQuery(err2)) throw err2;
        return (await graph(cfg, url(plainer))).value ?? [];
      }
    }
  }

  /**
   * Flagged mail becomes tasks. With `flaggedCategory` set, only mail carrying
   * that category counts — that's the whole difference between the two accounts.
   *
   * Graph compares categories case-sensitively and so does the local sieve, so
   * "Taylor" and "taylor" are different categories as far as both are concerned.
   */
  async function fetchItems(cfg) {
    const items = [];
    const top = cfg.maxResults ?? 50;
    const category = cfg.flaggedCategory?.trim() || null;
    const withCategory = (f) => (category ? `${f} and ${categoryFilter(category)}` : f);
    const keep = (m) => !category || (m.categories ?? []).includes(category);

    if (cfg.flaggedMail !== false) {
      // A completed flag no longer matches 'flagged', so ask for those separately —
      // otherwise a flag you tick off in Outlook could never close the rodeo task.
      const messages = [
        ...await mailQuery(cfg, withCategory("flag/flagStatus eq 'flagged'"), top,
          'receivedDateTime desc', "flag/flagStatus eq 'flagged'"),
        ...await mailQuery(cfg, withCategory("flag/flagStatus eq 'complete'"), cfg.completedLookback ?? 25,
          'lastModifiedDateTime desc', "flag/flagStatus eq 'complete'"),
      ];
      for (const m of messages) {
        if (!keep(m)) continue;
        const from = m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'unknown sender';
        items.push({
          external_id: `mail:${m.id}`,
          title: m.subject?.trim() || '(no subject)',
          description: `From ${from}\n\n${(m.bodyPreview || '').trim()}`.slice(0, 4000),
          // An account with a taskLabel says what kind of work its mail is, not
          // merely that it was mail. Sync rewrites this every time, so renaming it
          // in config.json relabels the tasks already in the list.
          source_ref: cfg.taskLabel ? `${cfg.taskLabel} · ${from}` : `Email from ${from}`,
          source_url: m.webLink || null,
          external_status: m.flag?.flagStatus ?? null,
          due_date: dateOnly(m.flag?.dueDateTime?.dateTime),
          closed: m.flag?.flagStatus === 'complete',
        });
      }
    }

    if (cfg.todo) {
      const lists = await graph(cfg, '/me/todo/lists?$top=20');
      for (const list of lists.value ?? []) {
        const data = await graph(
          cfg,
          `/me/todo/lists/${list.id}/tasks?$top=${top}&$filter=${encodeURIComponent("status ne 'completed'")}`
        );
        for (const t of data.value ?? []) {
          items.push({
            external_id: `todo:${t.id}`,
            title: t.title?.trim() || '(untitled task)',
            description: (t.body?.content || '').trim().slice(0, 4000),
            source_ref: `To Do · ${list.displayName}`,
            source_url: null,
            external_status: t.status ?? null,
            due_date: dateOnly(t.dueDateTime?.dateTime),
            priority: t.importance === 'high' ? 'high' : t.importance === 'low' ? 'low' : null,
            closed: t.status === 'completed',
          });
        }
      }
    }

    return items;
  }

  /* ---------- unread ---------- */

  /**
   * Unread mail, read live for the strip above the task list.
   *
   * Deliberately not part of fetchItems: unread is a state of the mailbox, not a
   * commitment, and syncing it would turn a busy morning into fifty rodeo tasks
   * that reappear every sync until you read them. Reading one in Outlook should
   * make it leave this list, which only works if the list is never cached.
   *
   * Scoped to the inbox by default — "all unread" otherwise sweeps in Junk and
   * whatever a rule filed away years ago. Set unreadFolder to "all" for the lot.
   *
   * Two things are sieved out afterwards rather than in the query: categories in
   * `unreadExcludeCategories`, and anything `tracked` says is already a task. Graph
   * takes a negated categories/any() badly, and "is this a task" is a fact about
   * rodeo's database that Graph could not answer anyway. The cost is that the page
   * is trimmed after `unreadMax` rather than before, so a heavily filtered mailbox
   * shows fewer than the maximum — raise it if that bites.
   */
  async function fetchUnread(cfg, { tracked = new Set() } = {}) {
    const top = cfg.unreadMax ?? cfg.maxResults ?? 50;
    const folder = (cfg.unreadFolder ?? 'inbox').trim();
    const base = !folder || folder === 'all'
      ? '/me/messages'
      : `/me/mailFolders/${encodeURIComponent(folder)}/messages`;
    const path = `${base}?$filter=${encodeURIComponent('isRead eq false')}&$select=${MAIL_SELECT}&$top=${top}`;

    let data;
    try {
      data = await graph(cfg, `${path}&$orderby=${encodeURIComponent('receivedDateTime desc')}`);
    } catch (err) {
      if (!rejectedQuery(err)) throw err;
      data = await graph(cfg, path);
    }

    const excluded = (cfg.unreadExcludeCategories ?? []).filter(Boolean);
    const setAside = (m) => (m.categories ?? []).some((c) => excluded.includes(c));

    return (data.value ?? [])
      .filter((m) => !setAside(m) && !tracked.has(`mail:${m.id}`))
      .map((m) => ({
        id: m.id,
        subject: m.subject?.trim() || '(no subject)',
        from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'unknown sender',
        from_address: m.from?.emailAddress?.address || null,
        received: m.receivedDateTime ?? null,
        preview: (m.bodyPreview || '').trim().slice(0, 300),
        categories: m.categories ?? [],
        flagged: m.flag?.flagStatus === 'flagged',
        url: m.webLink || null,
      }));
  }

  /* ---------- calendar ---------- */

  /**
   * Meetings on one local day, for the recap.
   *
   * calendarView (not /events) is the one that expands recurring series into the
   * occurrences that actually sat on your calendar. Declined and cancelled events
   * are dropped: the recap answers where the day went, and those are the two cases
   * where the answer is "not here". Unanswered invites stay — plenty of meetings
   * get attended without anyone ever clicking Accept.
   */
  async function fetchMeetings(cfg, day) {
    // Graph reads naive boundaries as UTC, so send real instants and let the Prefer
    // header decide the zone the times come back in.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const start = new Date(`${day}T00:00:00`);
    const end = new Date(`${day}T23:59:59.999`);
    if (Number.isNaN(start.getTime())) throw new Error(`not a date: ${day}`);

    const params = new URLSearchParams({
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      $select: EVENT_SELECT,
      $orderby: 'start/dateTime',
      $top: String(cfg.maxResults ?? 50),
    });
    const data = await graph(cfg, `/me/calendarView?${params}`, {
      Prefer: `outlook.timezone="${zone}"`,
    }).catch((err) => {
      // Everything else works with a mail-only grant, so a 403 here means one thing.
      if (/403|Forbidden|AccessDenied/i.test(err.message)) {
        throw new Error('no calendar permission on this sign-in — ⚙ → Connect to sign in again');
      }
      throw err;
    });

    return (data.value ?? [])
      .filter((e) => !e.isCancelled && rsvp(e) !== 'declined')
      .map((e) => ({
        id: e.id,
        subject: e.subject?.trim() || '(no subject)',
        // Graph returns seven fractional digits, which not every Date parser accepts.
        start: e.start?.dateTime?.slice(0, 19) ?? null,
        end: e.end?.dateTime?.slice(0, 19) ?? null,
        all_day: Boolean(e.isAllDay),
        response: rsvp(e),
        organizer: e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || null,
        url: e.webLink || null,
      }));
  }

  return {
    id, label, sourceType, CALLBACK_PATH,
    configured, describe, hasToken, signOut,
    startLogin, handleCallback, pollLogin,
    fetchItems, fetchUnread, fetchMeetings,
  };
}

/* ---------- shared helpers ---------- */

const MAIL_SELECT = 'id,subject,webLink,receivedDateTime,bodyPreview,from,flag,isRead,categories';
const EVENT_SELECT = 'id,subject,start,end,isAllDay,isCancelled,responseStatus,organizer,webLink';

const b64url = (buf) => buf.toString('base64url');

/**
 * Whose mailbox this token is for, read out of the access token's own claims —
 * rodeo shows it in the ⚙ panel so two connected accounts can be told apart.
 * Not a security check: the claims are read without verifying the signature,
 * because Microsoft just handed us the token over TLS. A malformed one costs a
 * name in the UI and nothing else, so it fails to null rather than throwing.
 */
function decodeAccount(jwt) {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return claims.preferred_username || claims.upn || claims.email || null;
  } catch { return null; }
}

/** The three shapes Graph uses to say "not that query" — all worth retrying simpler. */
const rejectedQuery = (err) => /too complex|InefficientFilter|Graph 400/i.test(err.message);

/** OData escapes a quote by doubling it; a category is free text and can hold one. */
const categoryFilter = (name) => `categories/any(c:c eq '${name.replace(/'/g, "''")}')`;

/** Graph calls the organizer's own events 'organizer'; an unanswered invite is 'none'. */
function rsvp(event) {
  const response = event.responseStatus?.response || 'none';
  return response === 'notResponded' ? 'none' : response;
}

function page(heading, detail) {
  return `<!doctype html><meta charset="utf-8"><title>rodeo</title>
<body style="font:15px/1.5 system-ui;margin:0;display:grid;place-items:center;height:100vh">
<div style="text-align:center;max-width:44ch"><h2>🐂 ${heading}</h2><p>${detail}</p></div>`;
}

function dateOnly(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* ---------- the two accounts ---------- */

export const outlook = createOutlook({
  id: 'outlook',
  label: 'Outlook',
  requiredScopes: ['offline_access', 'Calendars.Read'],
});

export const outlook2 = createOutlook({
  id: 'outlook2',
  label: 'Outlook (second account)',
  requiredScopes: ['offline_access', 'Mail.Read'],
  // Its mail becomes its own kind of work, not "a task from account two".
  sourceType: 'ecrash',
});
