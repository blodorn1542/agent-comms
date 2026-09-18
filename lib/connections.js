'use strict';

/**
 * Where a tenant's provider credentials live.
 *
 * This is a port with a working default. A host that already stores OAuth
 * tokens per tenant - Nickel does, in its own `connections` table - passes its
 * own implementation to createComms and comms writes nowhere new. A host with
 * nothing of its own gets the default below and stays self-contained.
 *
 * The port is three functions:
 *
 *   save(tenantId, provider, tokens)   tokens: { accessToken, refreshToken,
 *                                       accessExpiresAt, refreshExpiresAt,
 *                                       externalId, externalName }
 *   get(tenantId, provider)            -> the stored row, or null. Callers read
 *                                       snake_case columns: access_token,
 *                                       refresh_token, access_expires_at,
 *                                       refresh_expires_at, external_id.
 *   remove(tenantId, provider)
 *
 * The snake_case read shape is deliberate: it is what a SQLite row looks like,
 * so a host backed by SQL implements this port by handing over its existing
 * row-returning functions rather than remapping every field.
 */

function createConnections(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comms_connections (
      tenant_id      TEXT NOT NULL,
      provider       TEXT NOT NULL,
      external_id    TEXT,
      external_name  TEXT,
      access_token   TEXT,
      refresh_token  TEXT,
      access_expires_at   INTEGER,
      refresh_expires_at  INTEGER,
      connected_at   TEXT,
      updated_at     TEXT,
      PRIMARY KEY (tenant_id, provider)
    );
  `);

  function get(tenantId, provider) {
    return db.prepare(
      'SELECT * FROM comms_connections WHERE tenant_id = ? AND provider = ?'
    ).get(tenantId, provider) ?? null;
  }

  function save(tenantId, provider, tokens) {
    const now = new Date().toISOString();
    const existing = get(tenantId, provider);
    db.prepare(`
      INSERT INTO comms_connections (tenant_id, provider, external_id, external_name,
        access_token, refresh_token, access_expires_at, refresh_expires_at,
        connected_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, provider) DO UPDATE SET
        external_id = COALESCE(excluded.external_id, comms_connections.external_id),
        external_name = COALESCE(excluded.external_name, comms_connections.external_name),
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        access_expires_at = excluded.access_expires_at,
        refresh_expires_at = excluded.refresh_expires_at,
        updated_at = excluded.updated_at
    `).run(
      tenantId, provider,
      tokens.externalId ?? null, tokens.externalName ?? null,
      tokens.accessToken ?? null, tokens.refreshToken ?? null,
      tokens.accessExpiresAt ?? null, tokens.refreshExpiresAt ?? null,
      existing?.connected_at ?? now, now,
    );
  }

  function remove(tenantId, provider) {
    db.prepare('DELETE FROM comms_connections WHERE tenant_id = ? AND provider = ?')
      .run(tenantId, provider);
  }

  return { save, get, remove };
}

/** Fail early and clearly when a host passes something that is not the port. */
function assertConnectionsPort(c) {
  for (const fn of ['save', 'get', 'remove']) {
    if (typeof c?.[fn] !== 'function') {
      throw new Error('connections port is missing ' + fn + '(). It needs save(tenantId, ' +
        'provider, tokens), get(tenantId, provider) and remove(tenantId, provider).');
    }
  }
  return c;
}

module.exports = { createConnections, assertConnectionsPort };
