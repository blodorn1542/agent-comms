'use strict';

/**
 * Gmail - OUTBOUND, per-tenant OAuth, sending from the client's own address.
 *
 * READ THIS BEFORE TOUCHING transmit(): the pipe is built here, but the switch
 * is not in this file. ../interface.js will not call transmit() unless every
 * gate opens, and the global gate is off. Building the adapter and enabling
 * sending are two separate decisions. Do not add a caller that bypasses the
 * interface.
 *
 * Google API, verified shapes:
 *   consent   https://accounts.google.com/o/oauth2/v2/auth
 *             access_type=offline + prompt=consent to get a refresh token
 *   token     https://oauth2.googleapis.com/token
 *   send      POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
 *   draft     POST https://gmail.googleapis.com/gmail/v1/users/me/drafts
 *   profile   GET  https://gmail.googleapis.com/gmail/v1/users/me/profile
 *
 * Scale note, not a today problem: sending on behalf of many outside businesses
 * eventually needs Google's OAuth app verification - a review gate like
 * Intuit's. One tenant on their own account does not.
 */

const crypto = require('node:crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PROVIDER = 'gmail';

/**
 * gmail.send transmits; gmail.compose creates drafts in the tenant's mailbox.
 * Adding gmail.readonly later is what opens the two-way seam for reading
 * replies - deliberately not requested now, because we do not read mail yet.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
];

const REFRESH_SKEW_MS = 5 * 60 * 1000;

const descriptor = {
  name: PROVIDER,
  channel: 'email',
  capabilities: { outbound: true, inbound: false },
};

/* ------------------------------------------------- pure message assembly -- */

/** RFC 2047 encoding, so a subject with an accent or a dash survives. */
function encodeHeader(value) {
  const s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

/** Header injection guard: a newline in a header would split the message. */
function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function buildRawMessage({ from, to, subject, body, replyTo }) {
  const headers = [
    'From: ' + sanitizeHeader(from),
    'To: ' + sanitizeHeader(to),
    'Subject: ' + encodeHeader(sanitizeHeader(subject)),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (replyTo) headers.push('Reply-To: ' + sanitizeHeader(replyTo));
  const mime = headers.join('\r\n') + '\r\n\r\n' + String(body).replace(/\r?\n/g, '\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

/* ----------------------------------------------------------------- build -- */

function create({ connections, settings = {}, fetchImpl = fetch }) {
  /**
   * Credentials come from the host - passed to createComms, or falling back to
   * the environment so an existing deployment keeps working unchanged.
   */
  function cred(name, envName) {
    const v = settings[name] ?? process.env[envName];
    if (v === undefined || v === '') {
      throw new Error('Gmail adapter needs ' + name + ' (pass it to createComms as ' +
        'gmail.' + name + ', or set ' + envName + ')');
    }
    return v;
  }

  /* --------------------------------------------------------------- OAuth -- */

  /** state -> { tenantId, verifier, ts }. One replica, 15-minute window. */
  const pending = new Map();

  function prunePending() {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [k, v] of pending) if (v.ts < cutoff) pending.delete(k);
  }

  function authorizeUrl(state, tenantId) {
    prunePending();
    const verifier = crypto.randomBytes(48).toString('base64url');
    pending.set(state, { verifier, tenantId, ts: Date.now() });
    const params = new URLSearchParams({
      client_id: cred('clientId', 'GMAIL_CLIENT_ID'),
      redirect_uri: cred('redirectUri', 'GMAIL_REDIRECT_URI'),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return AUTH_URL + '?' + params.toString();
  }

  function takeVerifier(state) {
    prunePending();
    const p = pending.get(state);
    pending.delete(state);
    return p ? p.verifier : null;
  }

  async function postTokenRequest(body) {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: cred('clientId', 'GMAIL_CLIENT_ID'),
        client_secret: cred('clientSecret', 'GMAIL_CLIENT_SECRET'),
        ...body,
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error('Google token endpoint ' + res.status + ': ' + text.slice(0, 400));
    return JSON.parse(text);
  }

  function shapeTokens(json, previous) {
    const now = Date.now();
    return {
      accessToken: json.access_token,
      // Google returns a refresh token only on the first consent. Losing the
      // old one on a later refresh silently disconnects the tenant.
      refreshToken: json.refresh_token ?? previous?.refresh_token ?? null,
      accessExpiresAt: now + (json.expires_in ?? 3600) * 1000,
      refreshExpiresAt: null, // Google refresh tokens carry no fixed expiry
    };
  }

  async function exchangeCode(tenantId, code, state) {
    const verifier = takeVerifier(state);
    if (!verifier) throw new Error('Unknown or expired OAuth state - start the connect again');
    const json = await postTokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cred('redirectUri', 'GMAIL_REDIRECT_URI'),
      code_verifier: verifier,
    });
    const tokens = shapeTokens(json, null);
    if (!tokens.refreshToken) {
      throw new Error('Google returned no refresh token. Revoke the app at ' +
        'myaccount.google.com/permissions and connect again so consent reappears.');
    }
    connections.save(tenantId, PROVIDER, tokens);

    // Record which address this tenant now sends from - the point of per-tenant
    // OAuth is that the address is theirs, not ours.
    try {
      const profile = await apiGet(tenantId, '/profile');
      connections.save(tenantId, PROVIDER, {
        ...tokens, externalId: profile.emailAddress, externalName: profile.emailAddress,
      });
    } catch { /* the address is a nicety; the tokens are the thing */ }

    return tokens;
  }

  async function getValidAccessToken(tenantId) {
    const row = connections.get(tenantId, PROVIDER);
    if (!row?.refresh_token) {
      throw new Error('Tenant "' + tenantId + '" has not connected Gmail yet');
    }
    const fresh = row.access_token && row.access_expires_at &&
                  row.access_expires_at - REFRESH_SKEW_MS > Date.now();
    if (fresh) return row.access_token;

    const json = await postTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    });
    const tokens = shapeTokens(json, row);
    connections.save(tenantId, PROVIDER, tokens);
    return tokens.accessToken;
  }

  function isConnected(tenantId) {
    return !!connections.get(tenantId, PROVIDER)?.refresh_token;
  }

  function sendingAddress(tenantId) {
    return connections.get(tenantId, PROVIDER)?.external_id ?? null;
  }

  function disconnect(tenantId) {
    connections.remove(tenantId, PROVIDER);
  }

  /* ------------------------------------------------------------ API calls -- */

  async function apiGet(tenantId, path) {
    const token = await getValidAccessToken(tenantId);
    const res = await fetchImpl(API_BASE + path, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error('Gmail ' + res.status + ' on ' + path + ': ' + text.slice(0, 300));
    return JSON.parse(text);
  }

  async function apiPost(tenantId, path, payload) {
    const token = await getValidAccessToken(tenantId);
    const res = await fetchImpl(API_BASE + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error('Gmail ' + res.status + ' on ' + path + ': ' + text.slice(0, 300));
    return JSON.parse(text);
  }

  function addressFor(tenantId, config) {
    const from = sendingAddress(tenantId);
    if (!from) throw new Error('Tenant "' + tenantId + '" has no connected Gmail address');
    return config?.tone?.companyName ? config.tone.companyName + ' <' + from + '>' : from;
  }

  /* -------------------------------------------------------------- outbound -- */

  /**
   * Actually send. Reached only through the interface's send(), and only when
   * every gate there opens. Nothing in this package calls it directly.
   */
  async function transmit({ tenantId, config, to, subject, body, meta }) {
    const raw = buildRawMessage({
      from: addressFor(tenantId, config),
      to, subject, body,
      replyTo: config?.comms?.email?.replyTo ?? null,
    });
    const res = await apiPost(tenantId, '/messages/send', {
      raw,
      ...(meta?.threadId ? { threadId: meta.threadId } : {}),
    });
    return { id: res.id, threadId: res.threadId };
  }

  /**
   * Create a real draft in the tenant's own Gmail, for a human to read and send
   * by hand. A write to the mailbox, but not a send, and NOT part of the
   * default path - the interface's draft() queues locally instead. Call this
   * only when a tenant has explicitly asked for drafts in their mailbox.
   */
  async function createDraft({ tenantId, config, to, subject, body }) {
    const raw = buildRawMessage({
      from: addressFor(tenantId, config),
      to, subject, body,
      replyTo: config?.comms?.email?.replyTo ?? null,
    });
    const res = await apiPost(tenantId, '/drafts', { message: { raw } });
    return { id: res.id, messageId: res.message?.id };
  }

  return {
    ...descriptor,
    transmit, createDraft,
    authorizeUrl, exchangeCode, getValidAccessToken,
    isConnected, sendingAddress, disconnect,
  };
}

module.exports = {
  ...descriptor, create,
  buildRawMessage, encodeHeader, sanitizeHeader,
  SCOPES, API_BASE,
};
