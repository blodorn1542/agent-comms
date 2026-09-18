'use strict';

/**
 * agent-comms - the shared communication layer for the agent platform.
 *
 * One interface agents call; providers are interchangeable adapters behind it.
 * This package knows nothing about any agent that uses it: no invoices, no
 * findings, no collections tiers. The dependency runs one way only.
 *
 *   const { createComms } = require('agent-comms');
 *
 *   // sharing the host's database and its existing credential storage
 *   const comms = createComms({ db, connections });
 *
 *   // or fully self-contained
 *   const comms = createComms({ dbPath: '/data/comms.db' });
 *
 * Sending is off by default and stays off until a human turns it on. See
 * lib/interface.js for the gates.
 */

const { openDatabase } = require('./lib/db');
const { createStore, normalizeAddress } = require('./lib/store');
const { createConnections, assertConnectionsPort } = require('./lib/connections');
const { createInterface, assertCanSend, assertCanReceive, withinSendWindow } = require('./lib/interface');
const gmail = require('./lib/adapters/gmail');
const quo = require('./lib/adapters/quo');

/** The adapters this package ships. Adding a provider is one more entry. */
const ADAPTER_MODULES = { gmail, quo };

/**
 * @param {object}  options
 * @param {object} [options.db]           an open node:sqlite DatabaseSync handle
 * @param {string} [options.dbPath]       where to open one, if no db is passed
 * @param {object} [options.connections]  credential storage port; see lib/connections.js
 * @param {boolean}[options.sendEnabled]  global kill switch. Omit and the
 *                                        environment decides (COMMS_SEND_ENABLED).
 *                                        Passing false pins it off regardless.
 * @param {object} [options.gmail]        { clientId, clientSecret, redirectUri }
 * @param {function}[options.fetchImpl]   injectable fetch, for tests
 */
function createComms(options = {}) {
  const { db, dbPath, connections, sendEnabled, fetchImpl = fetch } = options;

  const database = db || openDatabase(dbPath);
  const store = createStore(database);
  const conns = connections
    ? assertConnectionsPort(connections)
    : createConnections(database);

  const ctx = { store, connections: conns, fetchImpl };
  const adapters = Object.fromEntries(
    Object.entries(ADAPTER_MODULES).map(([name, mod]) => [
      name,
      mod.create({ ...ctx, settings: options[name] || {} }),
    ])
  );

  const api = createInterface({ store, adapters, sendEnabled });

  return {
    ...api,
    adapters,
    store,
    connections: conns,
    /** Escape hatch for a host that needs a provider's own methods (OAuth, probe). */
    adapter: (name) => api.adapterFor(name),
  };
}

module.exports = {
  createComms,
  // Pure helpers, usable without constructing anything.
  assertCanSend, assertCanReceive, withinSendWindow, normalizeAddress,
  createStore, createConnections, openDatabase,
  adapters: ADAPTER_MODULES,
};
