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
 * Every request this file makes is a GET. assertReadOnlyPath() below rejects
 * any other verb before it reaches the network, so "read-only" is a property
 * of the code rather than a claim in a comment. test/comms.test.js proves it.
 *
 * Because nothing is sent, this adapter is safe to run live as soon as a
 * tenant supplies an API key.
 *
 * ---------------------------------------------------------------------------
 * API shape, verified 2026-09-18 against the published OpenAPI 3.1 spec
 * (openphone-public-api-prod.s3.us-west-2.amazonaws.com/public/
 *  openphone-public-api-v1-prod.json) and the docs at quo.com/docs:
 *
 *   base        https://api.quo.com          paths carry their own /v1
 *   auth        Authorization: <API_KEY>     apiKey in header, NOT "Bearer"
 *   rate limit  10 requests/second per key
 *
 *   GET /v1/phone-numbers                    -> { data: [...] }, no paging
 *   GET /v1/conversations                    ?phoneNumbers=<E.164> (repeated)
 *   GET /v1/messages                         ?phoneNumberId= &participants=
 *   GET /v1/calls                            ?phoneNumberId= &participants=
 *   GET /v1/call-summaries/{callId}          business/scale plans only
 *   GET /v1/call-transcripts/{callId}        business/scale plans only
 *   GET /v1/call-voicemails/{callId}         { duration, id, transcript,
 *                                            recordingUrl, status } with status
 *                                            "completed" | "in-progress"; the
 *                                            fields are null while processing
 *                                            (docs, verified 2026-09-28)
 *
 * Three facts here cost the previous revision of this file its correctness, so
 * they are written down:
 *
 *   1. direction is "incoming"/"outgoing" - NOT "inbound"/"outbound". Filtering
 *      on "inbound" silently matches nothing and ingests an empty set.
 *   2. /v1/messages and /v1/calls require BOTH phoneNumberId and participants.
 *      There is no "everything on this number" call, which is why poll() walks
 *      /v1/conversations first to learn who the participants are. Further:
 *      on /v1/CALLS `participants` accepts AT MOST ONE number (spec:
 *      maxItems 1, "limited to one-to-one conversations"; the live API
 *      rejects two with 400 "Expected array length to be less or equal to
 *      1"). On /v1/MESSAGES it takes up to 10, and one number returns only the
 *      1:1 thread: a GROUP thread's messages come back only when all its
 *      participants are passed together (corrected 2026-09-28 - the 9/18 note
 *      applied the calls limit to messages too, and group texts were never
 *      read).
 *   3. maxResults is required (1-100) and list responses are enveloped as
 *      { data, totalItems, nextPageToken }, nextPageToken nullable.
 */

const API_BASE = 'https://api.quo.com';
const PROVIDER = 'quo';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** 10 req/sec ceiling; 120ms between calls keeps us comfortably under it. */
const THROTTLE_MS = 120;

/** How far back a first-ever poll reaches, when there is no cursor yet. */
const FIRST_POLL_DAYS = 14;

/**
 * A counterparty ceiling per number, so one poll of a busy workspace cannot
 * fan out into thousands of requests - each counterparty costs two requests
 * plus one per incoming call. Raise it in config if a tenant needs it.
 */
const MAX_CONVERSATIONS = 200;

/** Group texts: how far back they are re-read, and the API's participant ceiling. */
const GROUP_WINDOW_DAYS = 7;
const MAX_GROUP_PARTICIPANTS = 10;
const MAX_GROUPS = 50;

/** Quo's own vocabulary, kept in one place rather than spread through poll(). */
const INCOMING = 'incoming';

const descriptor = {
  name: PROVIDER,
  channel: 'sms',
  capabilities: { outbound: false, inbound: true },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isoDaysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The read-only guarantee, as a function. Every request funnels through
 * apiGet(), and apiGet() funnels through here. A future edit that tries to
 * POST - or to reach a mutating path with a GET - throws before any socket is
 * opened, rather than being caught in review.
 */
const MUTATING_PATH = /\/(mark-as-read|mark-as-done|mark-as-open|complete|reopen|assign|unassign|link-conversation|unlink-conversation|change-due-date|remove-due-date|webhooks|tasks|contacts)\b/;

function assertReadOnlyPath(method, path) {
  if (method !== 'GET') {
    throw new Error('quo adapter is read-only: refusing a ' + method + ' to ' + path);
  }
  if (MUTATING_PATH.test(path)) {
    throw new Error('quo adapter is read-only: "' + path + '" is a mutating or ' +
      'write-capable Quo endpoint and is not reachable from this adapter.');
  }
  return true;
}

/** Quo returns summary/nextSteps as string arrays; flatten for the body column. */
function flattenText(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const parts = value.map(flattenText).filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }
  if (typeof value === 'object') return null;
  const s = String(value).trim();
  return s || null;
}

/** A call summary rendered as something a human or an LLM can read directly. */
function summaryToBody(summary) {
  if (!summary) return null;
  const body = flattenText(summary.summary);
  const next = flattenText(summary.nextSteps);
  const out = [];
  if (body) out.push(body);
  if (next) out.push('Next steps: ' + next);
  return out.length ? out.join('\n\n') : null;
}

function create({ store, connections, settings = {}, fetchImpl = fetch }) {
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

  /**
   * Per-tenant storage wins; a host-supplied key is next; the environment is
   * the last resort. That order is what lets the same build run multi-tenant
   * locally and single-tenant on Railway with QUO_API_KEY in Variables, with
   * no code change and no key in the repo.
   */
  function getApiKey(tenantId) {
    const stored = connections.get(tenantId, PROVIDER)?.access_token;
    const key = stored || settings.apiKey || process.env.QUO_API_KEY;
    if (!key) {
      throw new Error('Tenant "' + tenantId + '" has no Quo API key. Set QUO_API_KEY ' +
        'in the environment, pass createComms({ quo: { apiKey } }), or store one per ' +
        'tenant with adapter("quo").saveApiKey(). Generate the key in Quo under ' +
        'Settings > API (Owner or Admin only).');
    }
    return key;
  }

  function isConnected(tenantId) {
    try {
      return !!getApiKey(tenantId);
    } catch {
      return false;
    }
  }

  function disconnect(tenantId) {
    connections.remove(tenantId, PROVIDER);
  }

  /* ------------------------------------------------------------ API reads -- */

  /**
   * Array params are serialized as repeated keys (OpenAPI form/explode, the
   * default the spec leaves unset), which is what `participants` needs.
   */
  async function apiGet(tenantId, path, params = {}) {
    assertReadOnlyPath('GET', path);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.set(k, String(v));
    }
    const url = API_BASE + path + (qs.toString() ? '?' + qs.toString() : '');

    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: getApiKey(tenantId), Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error('Quo ' + res.status + ' on ' + path + ': ' + text.slice(0, 300));
      err.status = res.status;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Quo returned non-JSON on ' + path + ': ' + text.slice(0, 200));
    }
  }

  /** Walk { data, nextPageToken } until the token runs out or MAX_PAGES caps it. */
  async function readList(tenantId, path, params, limit = MAX_PAGES) {
    const rows = [];
    let pageToken;
    for (let page = 0; page < limit; page++) {
      const json = await apiGet(tenantId, path, {
        ...params, maxResults: PAGE_SIZE, pageToken,
      });
      const batch = json?.data;
      if (!Array.isArray(batch)) {
        throw new Error('Quo ' + path + ': expected a list under "data", got ' +
          JSON.stringify(Object.keys(json ?? {})).slice(0, 200));
      }
      rows.push(...batch);
      pageToken = json.nextPageToken ?? null;
      if (!pageToken || batch.length === 0) break;
      await sleep(THROTTLE_MS);
    }
    return rows;
  }

  /** /v1/phone-numbers is a plain { data: [...] } with no paging. */
  async function listPhoneNumbers(tenantId) {
    const json = await apiGet(tenantId, '/v1/phone-numbers', {});
    return Array.isArray(json?.data) ? json.data : [];
  }

  /** Conversations are keyed by the E.164 number, not by the phoneNumberId. */
  const listConversations = (tenantId, e164, updatedAfter) =>
    readList(tenantId, '/v1/conversations', {
      phoneNumbers: [e164], updatedAfter, excludeInactive: true,
    });

  /**
   * One participant per request - the live API caps the array at 1. Callers
   * pass a single number; the array wrapper is what the parameter expects.
   */
  const listMessages = (tenantId, phoneNumberId, participant, createdAfter) =>
    readList(tenantId, '/v1/messages',
      { phoneNumberId, participants: Array.isArray(participant) ? participant : [participant], createdAfter });

  const listCalls = (tenantId, phoneNumberId, participant, createdAfter) =>
    readList(tenantId, '/v1/calls',
      { phoneNumberId, participants: [participant], createdAfter });

  /**
   * Call summaries and transcripts are a Business/Scale feature. A tenant on a
   * lower plan gets 403/404 here, and a call that was never processed comes
   * back with status "absent". Neither is an error: the caller records the
   * call without a summary and carries on.
   */
  async function fetchCallSummary(tenantId, callId) {
    try {
      const json = await apiGet(tenantId, '/v1/call-summaries/' + encodeURIComponent(callId));
      const data = json?.data ?? null;
      if (!data) return { summary: null, reason: 'empty' };
      // "absent" is the normal answer for a no-answer call: nothing was said,
      // so there is nothing to summarize. That is not a plan limit.
      if (data.status !== 'completed') return { summary: null, reason: data.status };
      return { summary: data, reason: null };
    } catch (err) {
      // Verified live 2026-09-18: a call Quo never summarized answers 404, and
      // that is the common case - no-answer calls, very short calls, and calls
      // older than the summarization window all 404 on an account where
      // summaries otherwise work. Only 402/403 mean the plan or the key is the
      // problem. Conflating the two reports a billing issue that isn't there.
      if ([402, 403].includes(err.status)) return { summary: null, reason: 'plan' };
      if ([400, 404].includes(err.status)) return { summary: null, reason: 'missing' };
      throw err;
    }
  }

  /** The public read: the summary, or null when there isn't one. */
  async function getCallSummary(tenantId, callId) {
    return (await fetchCallSummary(tenantId, callId)).summary;
  }

  async function getCallTranscript(tenantId, callId) {
    try {
      const json = await apiGet(tenantId, '/v1/call-transcripts/' + encodeURIComponent(callId));
      const data = json?.data ?? null;
      return data && data.status !== 'absent' ? data : null;
    } catch (err) {
      if ([400, 402, 403, 404].includes(err.status)) return null;
      throw err;
    }
  }

  /**
   * A call's voicemail: what the caller SAID, which a call summary does not
   * carry (2026-09-28: a closing request left as a voicemail reached Bear as
   * an empty call and was dropped). Quo transcribes it after the call ends,
   * so an early read finds it still processing - the caller asks again later.
   *
   * @returns {Promise<{ status: 'completed'|'in-progress'|'none'|'unavailable',
   *   transcript: string|null, duration: number|null }>}
   *   none         no voicemail on this call (400/404)
   *   unavailable  the plan or the key does not allow it (402/403)
   */
  async function getCallVoicemail(tenantId, callId) {
    const empty = (status) => ({ status, transcript: null, duration: null });
    try {
      const json = await apiGet(tenantId, '/v1/call-voicemails/' + encodeURIComponent(callId));
      const data = json?.data ?? null;
      if (!data) return empty('in-progress');
      if (data.status !== 'completed') return empty('in-progress');
      const transcript = typeof data.transcript === 'string' && data.transcript.trim()
        ? data.transcript.trim() : null;
      const duration = Number.isFinite(Number(data.duration)) ? Number(data.duration) : null;
      return { status: 'completed', transcript, duration };
    } catch (err) {
      if ([400, 404].includes(err.status)) return empty('none');
      if ([402, 403].includes(err.status)) return empty('unavailable');
      throw err;
    }
  }

  /* --------------------------------------------------------------- ingest -- */

  /**
   * Pull new texts (both directions) and incoming call summaries into
   * comms_inbound.
   *
   * Texts are stored in BOTH directions since 2026-09-27: an outgoing text is
   * the office answering a customer, and "did this person get a reply?" (the
   * customer-service queue) cannot be answered without it. It is stored as
   * direction 'outbound' with the office line as `from` and the customer as
   * `to`; nothing here sends one (there is still no transmit()). Calls stay
   * incoming only: an outgoing call has no summary worth reading here and
   * costs a request per call. Storage is idempotent on Quo's own id, so an
   * overlapping window costs nothing and a re-poll after a crash duplicates
   * nothing.
   *
   * Shape of the walk, forced by the API requiring `participants`:
   *   phone numbers -> conversations on each -> messages + calls per
   *   conversation -> summary per incoming call.
   */
  async function poll({ tenantId, config, now = new Date() }) {
    const opts = config?.comms?.inbound?.quo || {};
    const wantSummaries = opts.callSummaries !== false;
    const wantTranscripts = opts.transcripts === true;
    const maxParticipants = opts.maxParticipants ?? opts.maxConversations ?? MAX_CONVERSATIONS;

    const numbers = await listPhoneNumbers(tenantId);
    if (!numbers.length) {
      return { ok: true, phoneNumbers: 0, conversations: 0, messages: 0, calls: 0,
               newRows: 0, note: 'the Quo workspace has no phone numbers' };
    }

    let conversations = 0;
    let messages = 0;
    let calls = 0;
    let newRows = 0;
    let truncated = false;
    let planGated = false;
    let noSummary = 0;
    let groupsRead = 0;
    let groupNew = 0;
    let groupRefused = 0;
    let groupRefusal = null;
    let groupTooBig = 0;

    for (const n of numbers) {
      const phoneNumberId = n?.id;
      const e164 = n?.number;
      if (!phoneNumberId || !e164) continue;

      const scope = 'number:' + phoneNumberId;
      const since = store.getCursor(tenantId, PROVIDER, scope) ||
        isoDaysAgo(FIRST_POLL_DAYS, now);

      const convos = await listConversations(tenantId, e164, since);
      await sleep(THROTTLE_MS);
      conversations += convos.length;

      /*
       * Flatten conversations down to the distinct counterparties, because a
       * calls query takes exactly one participant and a one-number messages
       * query is that number's 1:1 thread (groups are read below). Going per-participant rather
       * than per-conversation also collapses the duplicate work when the same
       * number appears in several conversations on this line.
       */
      const counterparties = [...new Set(
        convos.flatMap((c) => c?.participants || []).filter((p) => p && p !== e164)
      )];
      if (counterparties.length > maxParticipants) truncated = true;

      const storeMessage = (m, group = null) => {
        messages++;
        if (!m?.id) return;
        const added = store.recordInbound({
          tenantId, provider: PROVIDER, channel: 'sms',
          externalId: m.id,
          direction: m.direction === INCOMING ? 'inbound' : 'outbound',
          from: m.from ?? null,
          to: Array.isArray(m.to) ? m.to.join(', ') : (m.to ?? null),
          body: m.text ?? null,
          occurredAt: m.createdAt ?? null,
          meta: { conversationId: m.conversationId ?? null,
                  media: m.media?.length ? m.media : null,
                  status: m.status ?? null,
                  phoneNumberId,
                  ...(group ? { groupParticipants: group } : {}) },
        });
        if (added) { newRows++; if (group) groupNew++; }
      };

      for (const participant of counterparties.slice(0, maxParticipants)) {
        for (const m of await listMessages(tenantId, phoneNumberId, participant, since)) storeMessage(m);
        await sleep(THROTTLE_MS);

        for (const c of await listCalls(tenantId, phoneNumberId, participant, since)) {
          calls++;
          if (c?.direction !== INCOMING) continue;

          let summary = null;
          let transcript = null;
          if (c.id && wantSummaries) {
            const got = await fetchCallSummary(tenantId, c.id);
            summary = got.summary;
            if (!summary) {
              noSummary++;
              if (got.reason === 'plan') planGated = true;
            }
            await sleep(THROTTLE_MS);
          }
          if (c.id && wantTranscripts) {
            transcript = await getCallTranscript(tenantId, c.id);
            await sleep(THROTTLE_MS);
          }

          // A call's counterpart is whoever is not the tenant's own number.
          const other = (c.participants || []).filter((p) => p !== e164);
          const added = store.recordInbound({
            tenantId, provider: PROVIDER, channel: 'call',
            externalId: c.id,
            direction: 'inbound',
            from: other[0] ?? null,
            to: e164,
            body: summaryToBody(summary),
            occurredAt: c.createdAt ?? null,
            meta: { status: c.status ?? null, duration: c.duration ?? null,
                    answeredAt: c.answeredAt ?? null, completedAt: c.completedAt ?? null,
                    aiHandled: c.aiHandled ?? null, phoneNumberId,
                    hasSummary: !!summary,
                    nextSteps: summary?.nextSteps ?? null,
                    transcript: transcript?.dialogue ?? null },
          });
          if (added) newRows++;
        }
        await sleep(THROTTLE_MS);
      }

      /*
       * Group texts (2026-09-28). /v1/messages with ONE participant returns
       * only the 1:1 thread with that number; a group thread's messages come
       * back only when ALL its participants are passed together (docs: "Passing
       * multiple participants will retrieve group conversation messages", up
       * to 10). The one-number limit above is real for /v1/calls ("limited to
       * one-to-one conversations"), not for messages. Missed until now: a
       * group thread relaying three closing requests ("Close 29 hedge row
       * lane...", "...47 Leo's Path") showed as an updated conversation with 0
       * messages read.
       *
       * Its own rolling window rather than the cursor, so a group thread whose
       * messages the cursor already moved past (every one before this change)
       * is read, and a thread is re-read while it stays in the window.
       * Storage is idempotent on Quo's id, so re-reading costs nothing.
       * A refusal is noted and skipped, never fatal: 1:1 traffic is unaffected.
       */
      const groupSince = isoDaysAgo(GROUP_WINDOW_DAYS, now);
      const groupConvos = groupSince < since ? await listConversations(tenantId, e164, groupSince) : convos;
      const groups = new Map();
      for (const c of groupConvos) {
        const parts = [...new Set((c?.participants || []).filter((p) => p && p !== e164))];
        if (parts.length < 2) continue;
        if (parts.length > MAX_GROUP_PARTICIPANTS) { groupTooBig++; continue; }
        groups.set([...parts].sort().join(','), parts);
      }
      for (const parts of [...groups.values()].slice(0, MAX_GROUPS)) {
        await sleep(THROTTLE_MS);
        let rows;
        try {
          rows = await listMessages(tenantId, phoneNumberId, parts, groupSince);
        } catch (err) {
          if (err.status !== 400) throw err;
          groupRefused++;
          groupRefusal = String(err.message).slice(0, 160);
          continue;
        }
        groupsRead++;
        for (const m of rows) storeMessage(m, parts);
      }
      if (groups.size > MAX_GROUPS) truncated = true;

      // Cursor moves only after the number is fully walked, so a mid-poll
      // failure re-reads rather than skips. Idempotent storage absorbs it.
      store.setCursor(tenantId, PROVIDER, scope, now.toISOString());
    }

    const notes = [];
    if (planGated) {
      notes.push('call summaries were refused by Quo - they are restricted to ' +
        'Business/Scale plans');
    } else if (noSummary) {
      notes.push(noSummary + ' incoming call(s) had no summary. That is normal: Quo ' +
        'answers 404 for a call it never summarized - no-answer, very short, or ' +
        'outside its summarization window - and "absent" for one not yet processed');
    }
    if (truncated) {
      notes.push('a number had more than ' + maxParticipants + ' active counterparties (or ' +
        MAX_GROUPS + ' group threads); raise comms.inbound.quo.maxParticipants to widen the walk');
    }
    if (groupsRead || groupRefused || groupTooBig) {
      notes.push('group texts: ' + groupsRead + ' thread(s) read in the last ' + GROUP_WINDOW_DAYS
        + ' days, ' + groupNew + ' new message(s)'
        + (groupRefused ? '; Quo REFUSED ' + groupRefused + ' group read(s): ' + groupRefusal : '')
        + (groupTooBig ? '; ' + groupTooBig + ' thread(s) over ' + MAX_GROUP_PARTICIPANTS + ' people skipped' : ''));
    }

    return {
      ok: true,
      phoneNumbers: numbers.length,
      conversations, messages, calls, newRows,
      note: notes.length ? notes.join('; ') : null,
    };
  }

  /**
   * First-connect check: call each endpoint once and report what came back, so
   * the field mapping above is confirmed against a real workspace instead of
   * assumed. Reads only, stores nothing.
   */
  async function probe(tenantId) {
    const out = { provider: PROVIDER, ok: true, checks: [] };
    const record = (name, fn) => fn().then(
      (v) => out.checks.push({ name, ok: true, ...v }),
      (e) => { out.ok = false; out.checks.push({ name, ok: false, error: e.message }); },
    );

    let firstNumber = null;
    await record('phone-numbers', async () => {
      const rows = await listPhoneNumbers(tenantId);
      firstNumber = rows[0] ?? null;
      return { count: rows.length,
               numbers: rows.map((r) => r.number).filter(Boolean),
               sampleKeys: rows[0] ? Object.keys(rows[0]) : [] };
    });

    let firstConvo = null;
    if (firstNumber?.number) {
      await record('conversations', async () => {
        const rows = await listConversations(tenantId, firstNumber.number, isoDaysAgo(30));
        firstConvo = rows[0] ?? null;
        return { count: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]) : [] };
      });
    }

    // One participant only: the live API rejects an array of two.
    const participant = (firstConvo?.participants || [])
      .find((p) => p && p !== firstNumber?.number);
    if (firstNumber?.id && participant) {
      await record('messages', async () => {
        const rows = await listMessages(tenantId, firstNumber.id, participant,
          isoDaysAgo(30));
        return { count: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]) : [],
                 directions: [...new Set(rows.map((r) => r.direction))] };
      });
      await record('calls', async () => {
        const rows = await listCalls(tenantId, firstNumber.id, participant,
          isoDaysAgo(30));
        return { count: rows.length, sampleKeys: rows[0] ? Object.keys(rows[0]) : [],
                 directions: [...new Set(rows.map((r) => r.direction))] };
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
    listPhoneNumbers, listConversations, listMessages, listCalls,
    getCallSummary, getCallTranscript, getCallVoicemail,
  };
}

module.exports = {
  ...descriptor, create, API_BASE, assertReadOnlyPath, summaryToBody,
};
