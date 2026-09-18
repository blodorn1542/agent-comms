'use strict';

/**
 * Verify the Quo adapter against a live workspace, read-only.
 *
 *   node scripts/quo-verify.js [tenantId]
 *
 * Reads QUO_API_KEY from .env (never committed - see .gitignore). Probes each
 * endpoint, runs one real poll into a local scratch database, and prints a
 * sample of the most recent incoming texts and call summaries.
 *
 * This script cannot send anything. It constructs comms with the outbound
 * switch pinned off, and the Quo adapter has no transmit() to call even if it
 * were on. It writes only to the scratch database named below.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createComms } = require('..');

/**
 * The only variables this script will ever adopt from a .env file.
 *
 * Deliberately an allow-list rather than "load everything". A shared .env - a
 * command-center file holding every credential a business owns - can be
 * pointed at safely, because nothing outside this list is read into the
 * process. One tool's verification run should not inherit every other tool's
 * secrets.
 */
const WANTED = ['QUO_API_KEY', 'QUO_TENANT', 'QUO_ENV_FILE', 'COMMS_SEND_ENABLED'];

/** Minimal .env reader: this package has no dependencies and keeps it that way. */
function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !WANTED.includes(m[1])) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return out;
}

/**
 * Local .env first; if it names a QUO_ENV_FILE, read that too. That
 * indirection is what lets the key live in exactly one place on disk instead
 * of being copied into every repo that needs it.
 */
function loadEnv() {
  const local = path.join(__dirname, '..', '.env');
  loadEnvFile(local);
  const chained = process.env.QUO_ENV_FILE;
  if (chained) loadEnvFile(chained);
  return { local, chained };
}

/** Never print a key, not even into a terminal the user might screenshot. */
function mask(key) {
  if (!key) return '(missing)';
  return key.length <= 8 ? '*'.repeat(key.length)
    : key.slice(0, 4) + '…' + key.slice(-2) + ' (' + key.length + ' chars)';
}

function line(s = '') { process.stdout.write(s + '\n'); }

function when(iso) {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso)
    : d.toLocaleString('en-US', { timeZone: 'America/New_York',
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

async function main() {
  const src = loadEnv();
  const tenant = process.argv[2] || process.env.QUO_TENANT || 'elite-pools';
  const apiKey = process.env.QUO_API_KEY;

  line('Quo adapter - live verification (read-only)');
  line('  tenant   ' + tenant);
  line('  key      ' + mask(apiKey));
  line('  key from ' + (src.chained || src.local));
  line();

  if (!apiKey) {
    line('No QUO_API_KEY found. Copy .env.example to .env and put the key in it.');
    line('Generate one in Quo under Settings > API (Owner or Admin required).');
    process.exitCode = 1;
    return;
  }

  // A scratch database outside the repo: verification must not leave state behind.
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quo-verify-')), 'quo.db');
  const comms = createComms({ dbPath, sendEnabled: false, quo: { apiKey } });
  const quo = comms.adapters.quo;

  /* ------------------------------------------------ the read-only assertion */

  line('Read-only check');
  line('  capabilities.outbound  ' + quo.capabilities.outbound);
  line('  transmit()             ' + (typeof quo.transmit === 'undefined'
    ? 'absent - there is no send path to disable' : 'PRESENT - STOP, this is a bug'));
  line();

  /* ------------------------------------------------------------- the probe */

  line('Probing endpoints');
  const probe = await quo.probe(tenant);
  for (const c of probe.checks) {
    if (c.ok) {
      const extra = [
        c.numbers?.length ? 'numbers: ' + c.numbers.join(', ') : null,
        c.directions?.length ? 'directions seen: ' + c.directions.join('/') : null,
      ].filter(Boolean).join(' | ');
      line('  [ok]   ' + c.name.padEnd(14) + String(c.count).padStart(4) + ' rows' +
        (extra ? '   ' + extra : ''));
    } else {
      line('  [FAIL] ' + c.name.padEnd(14) + c.error);
    }
  }
  line();
  if (!probe.ok) {
    line('At least one endpoint failed; not polling. Fix the above first.');
    process.exitCode = 1;
    return;
  }

  /* -------------------------------------------------------------- the poll */

  line('Polling (incoming texts + call summaries)');
  const config = { comms: { inbound: { quo: { enabled: true, callSummaries: true } } } };
  const started = Date.now();
  const res = await quo.poll({ tenantId: tenant, config });
  line('  phone numbers  ' + res.phoneNumbers);
  line('  conversations  ' + res.conversations);
  line('  messages seen  ' + res.messages + '   calls seen ' + res.calls);
  line('  stored (new)   ' + res.newRows + '   in ' +
    ((Date.now() - started) / 1000).toFixed(1) + 's');
  if (res.note) line('  note           ' + res.note);
  line();

  /* ------------------------------------------------------------ the sample */

  const rows = comms.store.recentInbound(tenant, 200);
  const texts = rows.filter((r) => r.channel === 'sms');
  const calls = rows.filter((r) => r.channel === 'call');

  line('Most recent incoming texts (' + texts.length + ' stored)');
  if (!texts.length) line('  (none in the polled window)');
  for (const t of texts.slice(0, 10)) {
    line('  ' + when(t.occurred_at).padEnd(22) + (t.from_addr ?? '?').padEnd(15) +
      truncate(t.body, 90));
  }
  line();

  line('Most recent incoming calls (' + calls.length + ' stored)');
  if (!calls.length) line('  (none in the polled window)');
  for (const c of calls.slice(0, 10)) {
    const meta = c.meta_json ? JSON.parse(c.meta_json) : {};
    line('  ' + when(c.occurred_at).padEnd(22) + (c.from_addr ?? '?').padEnd(15) +
      (meta.status ?? '?') + ', ' + (meta.duration ?? '?') + 's');
    line('      summary: ' + (c.body ? truncate(c.body, 200) : '(none available)'));
  }
  line();

  line('Sent during verification: ' + comms.store.sentCount(tenant) +
    ' (must be 0 - this adapter cannot send)');
  line('Scratch database: ' + dbPath);
}

main().catch((err) => {
  console.error('\nVerification failed: ' + err.message);
  process.exitCode = 1;
});
