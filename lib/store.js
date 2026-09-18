'use strict';

/**
 * Comms state, in tables this package owns outright:
 *
 *   comms_outbox   every outbound message, queued first and only ever marked
 *                  sent after the gate in ../lib/interface.js lets it through.
 *   comms_audit    append-only: who, what, when, which tenant, approved by whom.
 *   comms_optouts  a customer who said stop, per tenant and channel.
 *   comms_inbound  incoming texts and call summaries, one row per provider id.
 *   comms_cursors  how far each inbound poll has read, per tenant per scope.
 *
 * Every table is prefixed comms_ so this package can share a database file with
 * its host without either side having to know the other's schema.
 *
 * Note for hosts that keep their own proof-of-silence counter: nothing here
 * writes to any table this package did not create. A queued draft is not a
 * send, and it must never be recorded as one in the host's own tables.
 */

function createStore(db) {
  migrate(db);

  /* -------------------------------------------------------------- outbox -- */

  function queue({ tenantId, channel, provider, recipient, subject, body, status,
                   blockedReason = null, approvedBy = null, meta = null }) {
    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO comms_outbox (tenant_id, channel, provider, recipient, subject, body,
        status, blocked_reason, approved_by, approved_at, created_at, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      tenantId, channel, provider, recipient, subject ?? null, body,
      status, blockedReason, approvedBy, approvedBy ? now : null,
      now, meta ? JSON.stringify(meta) : null,
    );
    return Number(info.lastInsertRowid);
  }

  function markSent(outboxId, providerMessageId) {
    db.prepare(
      'UPDATE comms_outbox SET status = ?, sent_at = ?, provider_message_id = ? WHERE id = ?'
    ).run('sent', new Date().toISOString(), providerMessageId ?? null, outboxId);
  }

  function markFailed(outboxId, reason) {
    db.prepare('UPDATE comms_outbox SET status = ?, blocked_reason = ? WHERE id = ?')
      .run('failed', String(reason).slice(0, 500), outboxId);
  }

  function getOutbox(outboxId) {
    return db.prepare('SELECT * FROM comms_outbox WHERE id = ?').get(outboxId) ?? null;
  }

  function recentOutbox(tenantId, limit = 100) {
    return db.prepare(
      'SELECT * FROM comms_outbox WHERE tenant_id = ? ORDER BY id DESC LIMIT ?'
    ).all(tenantId, limit);
  }

  /** Proof-of-silence counter: how many rows actually left the building. */
  function sentCount(tenantId) {
    return db.prepare(
      "SELECT COUNT(*) AS n FROM comms_outbox WHERE tenant_id = ? AND status = 'sent'"
    ).get(tenantId).n;
  }

  /* --------------------------------------------------------------- audit -- */

  function audit({ tenantId, outboxId = null, event, channel = null, provider = null,
                   recipient = null, actor = 'system', detail = null }) {
    db.prepare(`
      INSERT INTO comms_audit (at, tenant_id, outbox_id, event, channel, provider,
                               recipient, actor, detail)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(new Date().toISOString(), tenantId, outboxId, event, channel, provider,
           recipient, actor, detail);
  }

  function recentAudit(tenantId, limit = 200) {
    return db.prepare(
      'SELECT * FROM comms_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT ?'
    ).all(tenantId, limit);
  }

  /* ------------------------------------------------------------- optouts -- */

  function addOptOut(tenantId, address, channel, reason = null) {
    db.prepare(`
      INSERT INTO comms_optouts (tenant_id, address, channel, reason, created_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(tenant_id, address, channel) DO NOTHING
    `).run(tenantId, normalizeAddress(address), channel, reason, new Date().toISOString());
  }

  function isOptedOut(tenantId, address, channel) {
    return !!db.prepare(
      'SELECT 1 FROM comms_optouts WHERE tenant_id = ? AND address = ? AND channel = ?'
    ).get(tenantId, normalizeAddress(address), channel);
  }

  function listOptOuts(tenantId) {
    return db.prepare('SELECT * FROM comms_optouts WHERE tenant_id = ?').all(tenantId);
  }

  /* ------------------------------------------------------------- inbound -- */

  /** @returns true when this was a new row, false when it had already been seen. */
  function recordInbound({ tenantId, provider, channel, externalId, direction,
                           from = null, to = null, body = null, occurredAt = null,
                           meta = null }) {
    const info = db.prepare(`
      INSERT INTO comms_inbound (tenant_id, provider, channel, external_id, direction,
        from_addr, to_addr, body, occurred_at, ingested_at, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, provider, external_id) DO NOTHING
    `).run(tenantId, provider, channel, String(externalId), direction,
           from, to, body, occurredAt, new Date().toISOString(),
           meta ? JSON.stringify(meta) : null);
    return info.changes > 0;
  }

  function recentInbound(tenantId, limit = 100) {
    return db.prepare(
      `SELECT * FROM comms_inbound WHERE tenant_id = ?
       ORDER BY COALESCE(occurred_at, ingested_at) DESC LIMIT ?`
    ).all(tenantId, limit);
  }

  function inboundCount(tenantId) {
    return db.prepare('SELECT COUNT(*) AS n FROM comms_inbound WHERE tenant_id = ?')
      .get(tenantId).n;
  }

  function getCursor(tenantId, provider, scope) {
    return db.prepare(
      'SELECT cursor FROM comms_cursors WHERE tenant_id = ? AND provider = ? AND scope = ?'
    ).get(tenantId, provider, scope)?.cursor ?? null;
  }

  function setCursor(tenantId, provider, scope, cursor) {
    db.prepare(`
      INSERT INTO comms_cursors (tenant_id, provider, scope, cursor, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(tenant_id, provider, scope) DO UPDATE SET
        cursor = excluded.cursor, updated_at = excluded.updated_at
    `).run(tenantId, provider, scope, cursor, new Date().toISOString());
  }

  return {
    queue, markSent, markFailed, getOutbox, recentOutbox, sentCount,
    audit, recentAudit,
    addOptOut, isOptedOut, listOptOuts,
    recordInbound, recentInbound, inboundCount, getCursor, setCursor,
  };
}

function normalizeAddress(address) {
  return String(address ?? '').trim().toLowerCase();
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comms_outbox (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id      TEXT NOT NULL,
      channel        TEXT NOT NULL,
      provider       TEXT NOT NULL,
      recipient      TEXT NOT NULL,
      subject        TEXT,
      body           TEXT NOT NULL,
      status         TEXT NOT NULL,
      blocked_reason TEXT,
      approved_by    TEXT,
      approved_at    TEXT,
      created_at     TEXT NOT NULL,
      sent_at        TEXT,
      provider_message_id TEXT,
      meta_json      TEXT
    );

    CREATE TABLE IF NOT EXISTS comms_audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      tenant_id  TEXT NOT NULL,
      outbox_id  INTEGER,
      event      TEXT NOT NULL,
      channel    TEXT,
      provider   TEXT,
      recipient  TEXT,
      actor      TEXT,
      detail     TEXT
    );

    CREATE TABLE IF NOT EXISTS comms_optouts (
      tenant_id  TEXT NOT NULL,
      address    TEXT NOT NULL,
      channel    TEXT NOT NULL,
      reason     TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, address, channel)
    );

    /* UNIQUE on the provider's own id makes ingest idempotent: re-polling an
       overlapping window duplicates nothing. */
    CREATE TABLE IF NOT EXISTS comms_inbound (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    TEXT NOT NULL,
      provider     TEXT NOT NULL,
      channel      TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      direction    TEXT NOT NULL,
      from_addr    TEXT,
      to_addr      TEXT,
      body         TEXT,
      occurred_at  TEXT,
      ingested_at  TEXT NOT NULL,
      meta_json    TEXT,
      UNIQUE (tenant_id, provider, external_id)
    );

    CREATE TABLE IF NOT EXISTS comms_cursors (
      tenant_id  TEXT NOT NULL,
      provider   TEXT NOT NULL,
      scope      TEXT NOT NULL,
      cursor     TEXT,
      updated_at TEXT,
      PRIMARY KEY (tenant_id, provider, scope)
    );

    CREATE INDEX IF NOT EXISTS idx_comms_outbox_tenant ON comms_outbox (tenant_id, id);
    CREATE INDEX IF NOT EXISTS idx_comms_audit_tenant ON comms_audit (tenant_id, id);
    CREATE INDEX IF NOT EXISTS idx_comms_inbound_tenant ON comms_inbound (tenant_id, occurred_at);
  `);
}

module.exports = { createStore, normalizeAddress };
