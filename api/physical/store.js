'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const TABLES = new Set(['users', 'rooms', 'devices', 'device_messages', 'observations', 'events', 'inferences', 'world_state', 'watches', 'actions', 'conversations', 'memories', 'commands', 'replay_runs', 'preferences']);

class PhysicalStore {
  constructor(filename = path.join(process.cwd(), 'data', 'adam-physical.sqlite')) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    for (const table of TABLES) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS observations_created ON observations(created_at); CREATE INDEX IF NOT EXISTS events_created ON events(created_at);');
  }

  put(table, value) {
    if (!TABLES.has(table)) throw new Error('Unknown table');
    if (!value?.id) throw new Error('Record ID required');
    const created = value.receivedAt || value.createdAt || value.timestamp || new Date().toISOString();
    this.db.prepare(`INSERT INTO ${table} (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(value.id, created, JSON.stringify(value));
    return value;
  }

  get(table, id) {
    if (!TABLES.has(table)) throw new Error('Unknown table');
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  }

  list(table, limit = 100) {
    if (!TABLES.has(table)) throw new Error('Unknown table');
    return this.db.prepare(`SELECT data FROM ${table} ORDER BY created_at DESC LIMIT ?`)
      .all(Math.min(Math.max(Number(limit) || 100, 1), 1000)).map(row => JSON.parse(row.data));
  }

  all(table) {
    if (!TABLES.has(table)) throw new Error('Unknown table');
    return this.db.prepare(`SELECT data FROM ${table}`).all().map(row => JSON.parse(row.data));
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.db.close(); }
}

module.exports = { PhysicalStore, TABLES };
