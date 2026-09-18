'use strict';

/**
 * The guardrails, tested as behaviour rather than trusted as comments.
 * Each one fails loudly here if someone loosens it.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createComms, adapters, withinSendWindow } = require('..');

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-')), 'test.db');
const comms = createComms({ dbPath: DB });

/** A tenant config with the window wide open, so window tests stay separate. */
function cfg(overrides = {}) {
  return {
    timezone: 'America/New_York',
    sendWindow: { days: [], startHour: 0, endHour: 24 },
    tone: { companyName: null },
    ...overrides,
    comms: { sendEnabled: false, email: { provider: 'gmail' }, inbound: {},
             ...(overrides.comms || {}) },
  };
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

/* ---------------------------------------------- guardrail 1: Quo can't send */

test('Quo is inbound-only by construction, not by configuration', () => {
  assert.equal(adapters.quo.capabilities.outbound, false);
  assert.equal(adapters.quo.capabilities.inbound, true);
  assert.equal(typeof comms.adapters.quo.transmit, 'undefined',
    'the built Quo adapter must expose no transmit()');
});

test('the interface refuses to route a send to an inbound-only adapter', async () => {
  await assert.rejects(
    comms.send({
      tenant: 't1',
      config: cfg({ comms: { email: { provider: 'quo' } } }),
      to: '+15550100', body: 'nope',
    }),
    /inbound-only and cannot send/,
  );
});

/* ------------------------------------- guardrail 2: nothing sends by default */

test('with everything at its default, a send is queued and never transmitted', async () => {
  const res = await withEnv('COMMS_SEND_ENABLED', undefined, () =>
    comms.send({ tenant: 't1', config: cfg(), to: 'a@example.com',
                 subject: 'Past due', body: 'Hello' }));

  assert.equal(res.transmitted, false);
  assert.equal(res.status, 'queued');
  // Every closed gate is named, not just the first.
  assert.ok(res.reasons.some((r) => /global send switch is off/.test(r)));
  assert.ok(res.reasons.some((r) => /comms\.sendEnabled false/.test(r)));
  assert.ok(res.reasons.some((r) => /no approval record/.test(r)));

  const row = comms.store.getOutbox(res.outboxId);
  assert.equal(row.status, 'queued');
  assert.equal(row.sent_at, null);
});

test('the global switch alone is not enough', () => {
  const d = withEnv('COMMS_SEND_ENABLED', 'true', () =>
    comms.sendDecision({ config: cfg(), tenantId: 't1', recipient: 'a@example.com',
                         channel: 'email', approval: { approvedBy: 'paul' } }));
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => /comms\.sendEnabled false/.test(r)));
});

test('the tenant switch alone is not enough', () => {
  const d = withEnv('COMMS_SEND_ENABLED', undefined, () =>
    comms.sendDecision({ config: cfg({ comms: { sendEnabled: true } }), tenantId: 't1',
                         recipient: 'a@example.com', channel: 'email',
                         approval: { approvedBy: 'paul' } }));
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => /global send switch is off/.test(r)));
});

test('an approval naming nobody does not count as an approval', () => {
  const d = withEnv('COMMS_SEND_ENABLED', 'true', () =>
    comms.sendDecision({ config: cfg({ comms: { sendEnabled: true } }), tenantId: 't1',
                         recipient: 'a@example.com', channel: 'email',
                         approval: { approvedBy: '' } }));
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => /no approval record/.test(r)));
});

test('a host can pin the switch off so the environment cannot open it', () => {
  const pinned = createComms({ dbPath: DB, sendEnabled: false });
  const d = withEnv('COMMS_SEND_ENABLED', 'true', () =>
    pinned.sendDecision({ config: cfg({ comms: { sendEnabled: true } }), tenantId: 't1',
                          recipient: 'pin@example.com', channel: 'email',
                          approval: { approvedBy: 'paul' } }));
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => /global send switch is off/.test(r)));
});

/* --------------------------------------------- guardrail 3: opt-out and hours */

test('a customer who opted out is never sent to, however many switches are on', () => {
  comms.store.addOptOut('t1', 'STOP@Example.com ', 'email', 'replied STOP');
  const d = withEnv('COMMS_SEND_ENABLED', 'true', () =>
    comms.sendDecision({ config: cfg({ comms: { sendEnabled: true } }), tenantId: 't1',
                         recipient: 'stop@example.com', channel: 'email',
                         approval: { approvedBy: 'paul' } }));
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => /opted out/.test(r)));
});

test('opt-out matching ignores case and surrounding whitespace', () => {
  assert.equal(comms.store.isOptedOut('t1', '  Stop@EXAMPLE.com', 'email'), true);
  assert.equal(comms.store.isOptedOut('t1', 'stop@example.com', 'sms'), false,
    'an email opt-out must not silence a different channel');
  assert.equal(comms.store.isOptedOut('t2', 'stop@example.com', 'email'), false,
    'opt-outs are per tenant');
});

test('quiet hours are evaluated in the tenant timezone, not the server one', () => {
  const c = { timezone: 'America/New_York',
              sendWindow: { days: [], startHour: 9, endHour: 17 } };
  // 13:00Z is 09:00 in New York in September (EDT), the first allowed hour.
  assert.equal(withinSendWindow(c, new Date('2026-09-16T13:00:00Z')).ok, true);
  // 11:00Z is 07:00 in New York - too early.
  assert.equal(withinSendWindow(c, new Date('2026-09-16T11:00:00Z')).ok, false);
  // 21:00Z is 17:00 in New York - endHour is exclusive.
  assert.equal(withinSendWindow(c, new Date('2026-09-16T21:00:00Z')).ok, false);
});

test('a day outside the send window blocks the send', () => {
  const c = { timezone: 'America/New_York',
              sendWindow: { days: ['mon'], startHour: 0, endHour: 24 } };
  // 2026-09-19 is a Saturday.
  const out = withinSendWindow(c, new Date('2026-09-19T16:00:00Z'));
  assert.equal(out.ok, false);
  assert.match(out.reason, /not a send day/);
});

/* ------------------------------------- the gate does open when it should open */

test('with every gate open the adapter is called once and the row is marked sent', async () => {
  const original = comms.adapters.gmail.transmit;
  let calls = 0;
  comms.adapters.gmail.transmit = async () => { calls++; return { id: 'MSG-123' }; };
  try {
    const res = await withEnv('COMMS_SEND_ENABLED', 'true', () =>
      comms.send({
        tenant: 't1', config: cfg({ comms: { sendEnabled: true } }),
        to: 'ok@example.com', subject: 'Past due', body: 'Hello',
        approval: { approvedBy: 'paul' },
      }));
    assert.equal(calls, 1);
    assert.equal(res.transmitted, true);
    assert.equal(res.status, 'sent');
    assert.equal(res.providerMessageId, 'MSG-123');
    const row = comms.store.getOutbox(res.outboxId);
    assert.equal(row.status, 'sent');
    assert.equal(row.approved_by, 'paul');
    assert.ok(row.sent_at);
  } finally {
    comms.adapters.gmail.transmit = original;
  }
});

test('a provider failure is recorded, not thrown at the caller', async () => {
  const original = comms.adapters.gmail.transmit;
  comms.adapters.gmail.transmit = async () => { throw new Error('Gmail 403 on /messages/send'); };
  try {
    const res = await withEnv('COMMS_SEND_ENABLED', 'true', () =>
      comms.send({
        tenant: 't1', config: cfg({ comms: { sendEnabled: true } }),
        to: 'fail@example.com', body: 'Hello', approval: { approvedBy: 'paul' },
      }));
    assert.equal(res.status, 'failed');
    assert.equal(res.transmitted, false);
    assert.equal(comms.store.getOutbox(res.outboxId).status, 'failed');
  } finally {
    comms.adapters.gmail.transmit = original;
  }
});

/* -------------------------------------------------- guardrail 4: audit trail */

test('every outbound decision lands in the audit log with its reason', () => {
  const rows = comms.store.recentAudit('t1', 200);
  assert.ok(rows.length > 0);
  const queued = rows.find((r) => r.event === 'queued' && r.recipient === 'a@example.com');
  assert.ok(queued, 'the first blocked send should be audited');
  assert.match(queued.detail, /global send switch is off/);
  const sent = rows.find((r) => r.event === 'transmitted');
  assert.equal(sent.actor, 'paul', 'the audit records who approved it');
});

/* ----------------------------------------------- draft() never goes anywhere */

test('draft() queues without evaluating any gate and cannot transmit', async () => {
  const original = comms.adapters.gmail.transmit;
  comms.adapters.gmail.transmit = async () => {
    throw new Error('draft() must never reach the provider');
  };
  try {
    const res = await withEnv('COMMS_SEND_ENABLED', 'true', () =>
      comms.draft({ tenant: 't1', to: 'draft@example.com', subject: 'Hi', body: 'Body' }));
    assert.equal(res.transmitted, false);
    assert.equal(comms.store.getOutbox(res.outboxId).status, 'queued');
  } finally {
    comms.adapters.gmail.transmit = original;
  }
});

/* --------------------------- this package stays inside its own tables ------- */

test('comms only ever creates tables it owns, so a host schema is never touched', () => {
  const { openDatabase } = require('..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comms-host-'));
  const db = openDatabase(path.join(dir, 'host.db'));
  db.exec('CREATE TABLE host_sends (id INTEGER PRIMARY KEY);');

  createComms({ db });

  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map((r) => r.name);
  assert.ok(names.includes('host_sends'), 'the host table survives');
  const ours = names.filter((n) => n !== 'host_sends' && !n.startsWith('sqlite_'));
  assert.deepEqual(ours.filter((n) => !n.startsWith('comms_')), [],
    'every table this package creates is prefixed comms_');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM host_sends').get().n, 0,
    'nothing is written to a host table');
});

/* ------------------------------------------------------- inbound behaviours */

test('ingesting the same provider id twice stores one row', () => {
  const row = {
    tenantId: 't1', provider: 'quo', channel: 'sms', externalId: 'MSG-abc',
    direction: 'inbound', from: '+15550100', to: '+15550199', body: 'I paid this already',
    occurredAt: '2026-09-17T12:00:00Z',
  };
  assert.equal(comms.store.recordInbound(row), true, 'first write is new');
  assert.equal(comms.store.recordInbound(row), false, 'second write is a no-op');
  const stored = comms.store.recentInbound('t1', 50).filter((r) => r.external_id === 'MSG-abc');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].body, 'I paid this already');
});

test('a tenant only polls inbound providers it has switched on', () => {
  assert.deepEqual(comms.inboundProvidersFor(cfg()), []);
  assert.deepEqual(
    comms.inboundProvidersFor(cfg({ comms: { inbound: { quo: { enabled: true } } } })),
    ['quo'],
  );
  // gmail is outbound-only, so asking for it inbound yields nothing.
  assert.deepEqual(
    comms.inboundProvidersFor(cfg({ comms: { inbound: { gmail: { enabled: true } } } })),
    [],
  );
});

test('Quo ingest keeps inbound only, and is driven entirely by injected fetch', async () => {
  const pages = {
    '/phone-numbers': { data: [{ id: 'PN1', phoneNumber: '+15550199' }] },
    '/messages': { data: [
      { id: 'M1', direction: 'inbound', from: '+15550100', to: ['+15550199'],
        content: 'call me', createdAt: '2026-09-17T10:00:00Z' },
      { id: 'M2', direction: 'outbound', from: '+15550199', to: ['+15550100'],
        content: 'ours', createdAt: '2026-09-17T10:05:00Z' },
    ] },
    '/calls': { data: [] },
  };
  const fetchImpl = async (url) => {
    const key = Object.keys(pages).find((k) => url.includes(k));
    return { ok: true, status: 200, text: async () => JSON.stringify(pages[key] ?? {}) };
  };
  const c = createComms({ dbPath: DB, fetchImpl });
  c.connections.save('tq', 'quo', { accessToken: 'key-123', refreshToken: null });

  const out = await c.poll({ tenant: 'tq', config: cfg(), provider: 'quo' });
  assert.equal(out.ok, true);
  assert.equal(out.messages, 2, 'both directions are seen');
  assert.equal(out.newRows, 1, 'only the inbound one is stored');
  const stored = c.store.recentInbound('tq', 10);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].external_id, 'M1');
});

test('Quo authenticates with the bare API key, not a Bearer token', async () => {
  let seenAuth = null;
  const fetchImpl = async (url, init) => {
    seenAuth = init.headers.Authorization;
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
  };
  const c = createComms({ dbPath: DB, fetchImpl });
  c.connections.save('tq2', 'quo', { accessToken: 'key-abc', refreshToken: null });
  await c.adapters.quo.listPhoneNumbers('tq2');
  assert.equal(seenAuth, 'key-abc');
  assert.equal(/^Bearer /.test(seenAuth), false);
});

/* ------------------------------------------------- Gmail message assembly -- */

test('a newline in a header cannot split the message', () => {
  const raw = adapters.gmail.buildRawMessage({
    from: 'a@example.com',
    to: 'victim@example.com\r\nBcc: everyone@example.com',
    subject: 'Past due\r\nX-Injected: yes',
    body: 'Hello',
  });
  const headerLines = Buffer.from(raw, 'base64url').toString('utf8')
    .split('\r\n\r\n')[0].split('\r\n');

  // The injected text survives as literal characters inside the To: and
  // Subject: values - that is fine, and Gmail rejects the malformed address.
  // What must never happen is it becoming a header line of its own.
  assert.equal(headerLines.some((l) => /^Bcc:/i.test(l)), false);
  assert.equal(headerLines.some((l) => /^X-Injected:/i.test(l)), false);
  assert.deepEqual(
    headerLines.map((l) => l.split(':')[0]),
    ['From', 'To', 'Subject', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding'],
  );
});

test('a non-ASCII subject is RFC 2047 encoded', () => {
  assert.equal(adapters.gmail.encodeHeader('Past due'), 'Past due');
  assert.match(adapters.gmail.encodeHeader('Montréal'), /^=\?UTF-8\?B\?/);
});

test('the message body round-trips with CRLF line endings', () => {
  const raw = adapters.gmail.buildRawMessage({
    from: 'a@example.com', to: 'b@example.com', subject: 'S', body: 'line one\nline two',
  });
  assert.match(Buffer.from(raw, 'base64url').toString('utf8'), /\r\nline one\r\nline two$/);
});

/* ----------------------------------------------- the connections port ------ */

test('a host can supply its own credential storage and comms writes nowhere else', () => {
  const calls = [];
  const fake = {
    save: (t, p, tok) => { calls.push(['save', t, p]); },
    get: (t, p) => { calls.push(['get', t, p]); return { access_token: 'host-key' }; },
    remove: (t, p) => { calls.push(['remove', t, p]); },
  };
  const c = createComms({ dbPath: DB, connections: fake });
  assert.equal(c.adapters.quo.isConnected('t9'), true);
  assert.deepEqual(calls[0], ['get', 't9', 'quo']);
});

test('a malformed connections port is rejected at construction, not at first use', () => {
  assert.throws(
    () => createComms({ dbPath: DB, connections: { get: () => null } }),
    /connections port is missing save\(\)/,
  );
});

/* --------------------------------------------------------- state reporting */

test('guardrailState reports what is actually true right now', () => {
  const state = withEnv('COMMS_SEND_ENABLED', undefined, () =>
    comms.guardrailState('t1', cfg()));
  assert.equal(state.globalSendEnabled, false);
  assert.equal(state.tenantSendEnabled, false);
  const byName = Object.fromEntries(state.adapters.map((a) => [a.name, a]));
  assert.equal(byName.quo.outbound, false);
  assert.equal(byName.quo.hasTransmit, false);
  assert.equal(byName.gmail.outbound, true);
  assert.equal(byName.gmail.inbound, false);
});
