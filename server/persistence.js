import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Camera persistence port.
 *
 * SQLite is the local adapter. A later PostgreSQL adapter can implement the
 * same async methods (list, get, create, close) without changing camera routes.
 *
 * Public rows are an allowlist: id, name, site, group, status, createdAt.
 * Credential material is not stored. URL userinfo is stripped from text fields
 * so a stream address cannot carry a secret into the client.
 */

const PUBLIC_FIELDS = ['id', 'name', 'site', 'group', 'status', 'createdAt'];
const MAX_TEXT = 120;

export function publicCamera(row) {
  const camera = {
    id: row.id,
    name: row.name,
    site: row.site ?? null,
    group: row.group ?? null,
    status: row.status,
    createdAt: row.createdAt
  };
  for (const key of Object.keys(camera)) {
    if (!PUBLIC_FIELDS.includes(key)) delete camera[key];
  }
  return camera;
}

export function createCameraStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1');
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      site TEXT,
      group_name TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL
    );
  `);

  const listStmt = db.prepare(`
    SELECT id, name, site, group_name AS "group", status, created_at AS createdAt
    FROM cameras
    ORDER BY created_at ASC, id ASC
  `);
  const getStmt = db.prepare(`
    SELECT id, name, site, group_name AS "group", status, created_at AS createdAt
    FROM cameras
    WHERE id = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO cameras (id, name, site, group_name, status, created_at)
    VALUES (?, ?, ?, ?, 'unknown', ?)
  `);

  return {
    async list() {
      return listStmt.all().map(publicCamera);
    },

    async get(id) {
      if (typeof id !== 'string' || !id) return null;
      const row = getStmt.get(id);
      return row ? publicCamera(row) : null;
    },

    async create(input) {
      const name = cleanText(input?.name, 'name');
      const site = cleanText(input?.site, 'site', true);
      const group = cleanText(input?.group, 'group', true);
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      insertStmt.run(id, name, site, group, createdAt);
      return publicCamera({ id, name, site, group, status: 'unknown', createdAt });
    },

    close() {
      db.close();
    }
  };
}

function cleanText(value, field, optional = false) {
  if (value == null || value === '') {
    if (optional) return null;
    invalid();
  }
  if (typeof value !== 'string') invalid();
  const redacted = redactUserinfo(value).trim();
  if (!redacted) {
    if (optional) return null;
    invalid();
  }
  if (redacted.length > MAX_TEXT) invalid();
  return redacted;
}

function redactUserinfo(value) {
  return value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
    '$1'
  );
}

function invalid() {
  const err = new Error('invalid_request');
  err.code = 'VALIDATION';
  throw err;
}
