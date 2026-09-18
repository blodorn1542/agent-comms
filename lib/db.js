'use strict';

/**
 * Opening a database is the host's job, not this package's.
 *
 * createComms({ db }) is the normal path: an agent that already has a SQLite
 * handle passes it in, and comms adds its own tables beside the host's. This
 * helper exists for the standalone case - a host that has no database of its
 * own and just wants comms to keep its state somewhere.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(dbPath) {
  if (!dbPath) throw new Error('createComms needs either a db handle or a dbPath');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

module.exports = { openDatabase };
