'use strict';

/**
 * Quo (formerly OpenPhone) - INBOUND, READ-ONLY.
 *
 * HARD RULE, enforced by construction rather than by configuration: nothing
 * here returns a transmit(). capabilities.outbound is false, and the interface
 * refuses to hand a message to an adapter that lacks both. There is no send
 * path to disable because there is no send path. Do not add one - outbound SMS
 * needs 10DLC carrier registration and an approval gate, and neither exists.
 *
 * Because nothing is sent, this adapter is safe to run live as soon as a tenant
 * supplies an API key.
 *
 * API shape, from Quo's published docs (2026-09-17):
 *   base            https://api.quo.com/v1
 *   auth            Authorization: <API_KEY>   <- NOT "Bearer <key>"
 *   GET /phone-numbers
 *   GET /messages?from=<phoneNumberId>&createdAfter=&maxResults=&pageToken=
 *   GET /calls?from=<phoneNumberId>&createdAfter=&maxResults=&pageToken=
 *   GET /call-summaries/{callId}     Business/Scale plans only
 *   GET /call-transcripts/{id}       Business/Scale plans only
 *   rate limit      10 requests/second across all endpoints
 *
 * The response envelope and field names have NOT been seen against a live
 * workspace. readList() therefore accepts the documented shape and the obvious
 * alternatives, and probe() reports what actually came back so FIELDS is
 * corrected from evidence rather than from assumption.
 */

const API_BASE = 'https://api.quo.com/v1';
const PROVIDER = 'quo';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** 10 req/sec ceiling; 120ms between calls keeps us comfortably under it. */
const THROTTLE_MS = 120;

/** How far back a first-ever poll reaches, when there is no cursor yet. */
const FIRST_POLL_DAYS = 14;

const FIELDS = {
  list: ['data', 'results', 'items'],
  nextPage: ['nextPageToken', 'pageToken', 'nextPage'],
  id: ['id'],
  body: ['content', 'text', 'body'],
  createdAt: ['createdAt', 'created_at'],
};

const descriptor = {
  name: PROVIDER,
  channel: 'sms',
  capabilities: { outbound: false, inbound: true },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(obj, names) {
  for (const n of names) if (obj?.[n] !== undefined) return obj[n];
  return undefined;
}

function isoDaysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function create({ store, connections, fetchImpl = fetch }) {
  /* ---------------------------------------------------------- credentials -- */

  /**
   * Quo issues a static API key rather than OAuth, so there is no refresh
   * token - a null refresh_token on this row is expected, not a broken row.
   */
  function saveApiKey(tenantId, apiKey, meta = {}) {
    connections.save(tenantId, PROVIDER, {
      accessToken: apiKey,
      refreshToken: null,
      externalId: meta.workspaceId ?? null,
      externalName: meta.workspaceName ?? null,
    });
  }

  function getApiKey(tenantId) {
    const row = connections.get(tenantId, PROVIDER);
    if (!row?.access_token) {
      throw new Error('Tenant "' + tenantId + '" has no Quo API key. ' +
        'Generate one in Quo under Settings > API (Owner or Admin only).');
    }
    return row.access_token;
  }

  function isConnected(tenantId) {
    return !!connections.get(tenantId, PROVIDER)?.access_token;
  }

  function disconnect(tenantId) {
    connections.remove(tenantId, PROVIDER);
  }

  /* ------------------------------------------------------------ API reads -- */

  async function apiGet(tenantId, path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.set(k, String(v));
    }
    const url = API_BASE + path + (qs.toString() ? '?' + qs.toString() : '');

    const res = await fetchImpl(url, {
      headers: { Authorization: getApiKey(tenantId), Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error('Quo ' + res.status + ' on ' + path + ': ' + text.slice(0, 300));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Quo returned non-JSON on ' + path + ': ' + text.slice(0, 200));
    }
  }

  async function readList(tenantId, path, params) {
    const rows = [];
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page++) {
      const json = await apiGet(tenantId, path, { ...params, maxResults: PAGE_SIZE, pageToken });
      const batch = pick(json, FIELDS.list);
      if (!Array.isArray(batch)) {
        throw new Error('Quo ' + path + ': expected a list under one of ' +
          FIELDS.list.join('/') + ', got ' +
          JSON.stringify(Object.keys(json ?? {})).slice(0, 200));
      }
      rows.push(...batch);
      pageToken = pick(json, FIELDS.nextPage);
      if (!pageToken || batch.length === 0) break;
      await sleep(THROTTLE_MS);
    }
    return rows;
  }

  const listPhoneNumbers = (tenantId) => readList(tenantId, '/phone-numbers', {});
  const listMessages = (tenantId, numberId, createdAfter) =>
    readList(tenantId, '/messages', { from: numberId, createdAfter });
  const listCalls = (tenantId, numberId, createdAfter) =>
    readList(tenantId, '/calls', { from: numberId, createdAfter });

  /**
   * Call summaries are a Business/Scale feature. A tenant on Starter gets a
   * 402/403/404 here; that is a plan limit, not a failure, so the caller
   * records the call without a summary and carries on.
   */
  async function getCallSummary(tenantId, callId) {
    try {
      return await apiGet(tenantId, '/call-summaries/' + encodeURIComponent(callId));
    } catch (err) {
      if (/\b(402|403|404)\b/.test(err.message)) return null;
      throw err;
    }
  }

  /* --------------------------------------------------------------- ingest -- */

  /**
   * Pull new inbound texts and call summaries into comms_inbound.
   *
   * Only direction === 'inbound' is stored: this adapter exists to hear what
   * customers said, not to mirror the tenant's own outbound traffic. Storage is
   * idempotent on Quo's own id, so an overlapping window costs nothing.
   */
  async function poll({ tenantId, config, now = new Date() }) {
    const wantSummaries = config?.comms?.inbound?.quo?.callSummaries !== false;
    const numbers = await listPhoneNumbers(tenantId);
    if (!numbers.length) {
      return { ok: true, phoneNumbers: 0, messages: 0, calls: 0, newRows: 0,
               note: 'the Quo workspace has no phone numbers' };
    }

    let messages = 0;
    let calls = 0;
    let newRows = 0;
    let summariesUnavailable = false;

    for (const n of numbers) {
      const numberId = pick(n, FIELDS.id);
      if (!numberId) continue;
      const scope = 'number:' + numberId;
      const since = store.getCursor(tenantId, PROVIDER, scope) ||
        isoDaysAgo(FIRST_POLL_DAYS, now);

      for (const m of await listMessages(tenantId, numberId, since)) {
        messages++;
        if (String(m.direction).toLowerCase() !== 'inbound') continue;
        const added = store.recordInbound({
          tenantId, provider: PROVIDER, channel: 'sms',
          externalId: pick(m, FIELDS.id),
          direction: 'inbound',
          from: m.from ?? null,
          to: Array.isArray(m.to) ? m.to.join(', ') : (m.to ?? null),
          body: pick(m, FIELDS.body) ?? null,
          occurredAt: pick(m, FIELDS.createdAt) ?? null,
          meta: { conversationId: m.conversationId ?? null, media: m.media ?? null,
                  phoneNumberId: numberId },
        });
        if (added) newRows++;
      }

      await sleep(THROTTLE_MS);

      for (const c of await listCalls(tenantId, numberId, since)) {
        calls++;
        if (String(c.direction).toLowerCase() !== 'inbound') continue;
        const callId = pick(c, FIELDS.id);
        let summary = null;
        if (wantSummaries && callId) {
          summary = await getCallSummary(tenantId, callId);
          if (summary === null) summariesUnavailable = true;
          await sleep(THROTTLE_MS);
        }
        const added = store.recordInbound({
          tenantId, provider: PROVIDER, channel: 'call',
          externalId: callId,
          direction: 'inbound',
          from: c.from ?? null,
          to: Array.isArray(c.to) ? c.to.join(', ') : (c.to ?? null),
          body: summary ? JSON.stringify(summary).slice(0, 4000) : null,
          occurredAt: pick(c, FIELDS.createdAt) ?? null,
          meta: { status: c.status ?? null, duration: c.duration ?? null,
                  phoneNumberId: numberId, hasSummary: !!summary },
        });
        if (added) newRows++;
      }

      store.setCursor(tenantId, PROVIDER, scope, now.toISOString());
      await sleep(THROTTLE_MS);
    }

    return {
      ok: true,
      phoneNumbers: numbers.length,
      messages, calls, newRows,
      note: summariesUnavailable
        ? 'some call summaries were unavailable - Quo restricts them to Business/Scale plans'
        : null,
    };
  }

  /**
   * First-connect check: call each endpoint once and report what came back, so
   * FIELDS above is confirmed against a real workspace instead of assumed.
   * Reads only.
   */
  async function probe(tenantId) {
    const out = { provider: PROVIDER, ok: true, checks: [] };
    const record = (name, fn) => fn().then(
      (v) => out.checks.push({ name, ok: true, ...v }),
      (e) => { out.ok = false; out.checks.push({ name, ok: false, error: e.message }); },
    );

    let firstNumberId = null;
    await record('phone-numbers', async () => {
      const rows = await listPhoneNumbers(tenantId);
      firstNumberId = rows.length ? pick(rows[0], FIELDS.id) : null;
      return { count: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] };
    });

    if (firstNumberId) {
      await record('messages', async () => {
        const rows = await listMessages(tenantId, firstNumberId, isoDaysAgo(7));
        return { count: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] };
      });
      await record('calls', async () => {
        const rows = await listCalls(tenantId, firstNumberId, isoDaysAgo(7));
        return { count: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] };
      });
    }

    out.canSend = false;
    out.note = 'read-only adapter: no transmit() is returned';
    return out;
  }

  return {
    ...descriptor,
    poll, probe,
    saveApiKey, getApiKey, isConnected, disconnect,
    listPhoneNumbers, listMessages, listCalls, getCallSummary,
  };
}

module.exports = { ...descriptor, create, FIELDS, API_BASE };
