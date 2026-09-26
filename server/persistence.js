import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseAuthenticateRequest } from './onvif-auth.js';

/**
 * Camera persistence port.
 *
 * SQLite is the local adapter. A later PostgreSQL adapter can implement the
 * same async methods (list, get, create, saveAuthenticated, close) without
 * changing camera routes.
 *
 * Public rows are an allowlist: id, name, site, group, status, createdAt.
 * Device login is stored only in camera_credentials. list, get, and create
 * never read that table. URL userinfo is stripped from text fields so a
 * stream address cannot carry a secret into the client.
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
    CREATE TABLE IF NOT EXISTS camera_credentials (
      camera_id TEXT PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
      host TEXT NOT NULL,
      onvif_port INTEGER NOT NULL,
      device_path TEXT NOT NULL,
      scheme TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (host, onvif_port)
    );
  `);
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    /* the database stays on this machine even if the mode cannot be set */
  }

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
  const insertAuthed = db.prepare(`
    INSERT INTO cameras (id, name, site, group_name, status, created_at)
    VALUES (?, ?, NULL, NULL, 'authenticated', ?)
  `);
  const findEndpoint = db.prepare(`
    SELECT camera_id FROM camera_credentials WHERE host = ? AND onvif_port = ?
  `);
  const insertCred = db.prepare(`
    INSERT INTO camera_credentials (
      camera_id, host, onvif_port, device_path, scheme, username, password, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateCred = db.prepare(`
    UPDATE camera_credentials
    SET device_path = ?, scheme = ?, username = ?, password = ?, updated_at = ?
    WHERE camera_id = ?
  `);
  const markAuthenticated = db.prepare(`
    UPDATE cameras SET status = 'authenticated' WHERE id = ?
  `);
  const renameCamera = db.prepare(`
    UPDATE cameras SET name = ? WHERE id = ?
  `);

  function read(id) {
    const row = getStmt.get(id);
    return row ? publicCamera(row) : null;
  }

  return {
    async list() {
      return listStmt.all().map(publicCamera);
    },

    async get(id) {
      if (typeof id !== 'string' || !id) return null;
      return read(id);
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

    async saveAuthenticated(input) {
      const parsed = parseAuthenticateRequest(input || {});
      const now = new Date().toISOString();
      const existing = findEndpoint.get(parsed.host, parsed.port);
      const id = existing ? existing.camera_id : randomUUID();
      const name = parsed.name || parsed.host;
      transaction(db, () => {
        if (existing) {
          updateCred.run(parsed.path, parsed.scheme, parsed.username, parsed.password, now, id);
          if (parsed.name) renameCamera.run(parsed.name, id);
          markAuthenticated.run(id);
        } else {
          insertAuthed.run(id, name, now);
          insertCred.run(id, parsed.host, parsed.port, parsed.path, parsed.scheme, parsed.username, parsed.password, now);
        }
      });
      const camera = read(id);
      if (!camera) {
        const err = new Error('internal_error');
        err.code = 'INTERNAL';
        throw err;
      }
      return camera;
    },

    close() {
      db.close();
    }
  };
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error is the one the caller needs */
    }
    throw err;
  }
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
