import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseAuthenticateRequest } from './onvif-auth.js';
import { runInterrogate } from './onvif-interrogate.js';
import { buildTestChecks, runDeviceProbe, testSummary } from './onvif-test.js';
import { runGetStreamUri } from './onvif-stream.js';

/**
 * Camera persistence port.
 *
 * SQLite is the local adapter. A later PostgreSQL adapter can implement the
 * same async methods (list, get, create, updateInventory, remove,
 * saveAuthenticated, interrogate, saveConfigured, runTest, confirmReview,
 * markSuccess, openLive, close) without changing camera routes.
 *
 * Public rows are an allowlist: id, name, site, group, status, createdAt,
 * plus optional non-secret configure fields manufacturer, model, profileId,
 * and profileLabel, plus optional lastTestAt, lastTestSummary, and
 * reviewedAt. Device login is stored only in camera_credentials. list, get,
 * create, updateInventory, remove, interrogate, saveConfigured, runTest,
 * confirmReview, and markSuccess never return that table. updateInventory
 * changes name, site, and group only. remove deletes the camera and its
 * login. openLive may return a server-side media source for the live proxy;
 * callers must not serialize that object.
 * URL userinfo is stripped from text fields so a stream address cannot
 * carry a secret into the client.
 */

const PUBLIC_FIELDS = ['id', 'name', 'site', 'group', 'status', 'createdAt'];
const OPTIONAL_PUBLIC_FIELDS = ['manufacturer', 'model', 'profileId', 'profileLabel'];
const TEST_SUMMARIES = new Set(['passed', 'failed']);
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
  for (const key of OPTIONAL_PUBLIC_FIELDS) {
    if (typeof row[key] === 'string' && row[key]) camera[key] = row[key];
  }
  if (TEST_SUMMARIES.has(row.lastTestSummary) && isoTimestamp(row.lastTestAt)) {
    camera.lastTestSummary = row.lastTestSummary;
    camera.lastTestAt = row.lastTestAt;
  }
  if (isoTimestamp(row.reviewedAt)) camera.reviewedAt = row.reviewedAt;
  const allowed = new Set([
    ...PUBLIC_FIELDS,
    ...OPTIONAL_PUBLIC_FIELDS,
    'lastTestAt',
    'lastTestSummary',
    'reviewedAt'
  ]);
  for (const key of Object.keys(camera)) {
    if (!allowed.has(key)) delete camera[key];
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
    CREATE TABLE IF NOT EXISTS camera_device_info (
      camera_id TEXT PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
      manufacturer TEXT,
      model TEXT,
      firmware TEXT,
      profiles_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'manufacturer', 'TEXT');
  ensureColumn(db, 'model', 'TEXT');
  ensureColumn(db, 'profile_id', 'TEXT');
  ensureColumn(db, 'profile_label', 'TEXT');
  ensureColumn(db, 'last_test_at', 'TEXT');
  ensureColumn(db, 'last_test_summary', 'TEXT');
  ensureColumn(db, 'reviewed_at', 'TEXT');
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    /* the database stays on this machine even if the mode cannot be set */
  }

  const listStmt = db.prepare(`
    SELECT id, name, site, group_name AS "group", status, created_at AS createdAt,
      manufacturer, model, profile_id AS profileId, profile_label AS profileLabel,
      last_test_at AS lastTestAt, last_test_summary AS lastTestSummary,
      reviewed_at AS reviewedAt
    FROM cameras
    ORDER BY created_at ASC, id ASC
  `);
  const getStmt = db.prepare(`
    SELECT id, name, site, group_name AS "group", status, created_at AS createdAt,
      manufacturer, model, profile_id AS profileId, profile_label AS profileLabel,
      last_test_at AS lastTestAt, last_test_summary AS lastTestSummary,
      reviewed_at AS reviewedAt
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
  const getCred = db.prepare(`
    SELECT host, onvif_port AS port, device_path AS path, scheme, username, password
    FROM camera_credentials
    WHERE camera_id = ?
  `);
  const clearDetails = db.prepare(`
    UPDATE cameras
    SET manufacturer = NULL, model = NULL, profile_id = NULL, profile_label = NULL,
      last_test_at = NULL, last_test_summary = NULL, reviewed_at = NULL
    WHERE id = ?
  `);
  const deleteSnapshot = db.prepare(`
    DELETE FROM camera_device_info WHERE camera_id = ?
  `);
  const upsertSnapshot = db.prepare(`
    INSERT INTO camera_device_info (
      camera_id, manufacturer, model, firmware, profiles_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(camera_id) DO UPDATE SET
      manufacturer = excluded.manufacturer,
      model = excluded.model,
      firmware = excluded.firmware,
      profiles_json = excluded.profiles_json,
      updated_at = excluded.updated_at
  `);
  const getSnapshot = db.prepare(`
    SELECT manufacturer, model, firmware, profiles_json
    FROM camera_device_info
    WHERE camera_id = ?
  `);
  const updateConfigured = db.prepare(`
    UPDATE cameras
    SET name = ?, site = ?, group_name = ?, status = 'configured',
      manufacturer = ?, model = ?, profile_id = ?, profile_label = ?,
      reviewed_at = NULL
    WHERE id = ?
  `);
  const markTested = db.prepare(`
    UPDATE cameras
    SET last_test_at = ?, last_test_summary = ?, reviewed_at = NULL
    WHERE id = ?
  `);
  const markReviewed = db.prepare(`
    UPDATE cameras SET reviewed_at = ? WHERE id = ?
  `);
  const markReady = db.prepare(`
    UPDATE cameras SET status = 'ready' WHERE id = ?
  `);
  const updateInventoryStmt = db.prepare(`
    UPDATE cameras SET name = ?, site = ?, group_name = ? WHERE id = ?
  `);
  const deleteCred = db.prepare(`
    DELETE FROM camera_credentials WHERE camera_id = ?
  `);
  const deleteCamera = db.prepare(`
    DELETE FROM cameras WHERE id = ?
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

    async updateInventory(id, input) {
      if (typeof id !== 'string' || !id) return { error: 'not_found' };
      const current = read(id);
      if (!current) return { error: 'not_found' };
      const name = hasOwn(input, 'name') ? cleanText(input.name, 'name') : current.name;
      const site = hasOwn(input, 'site') ? cleanText(input.site, 'site', true) : (current.site ?? null);
      const group = hasOwn(input, 'group') ? cleanText(input.group, 'group', true) : (current.group ?? null);
      updateInventoryStmt.run(name, site, group, id);
      const camera = read(id);
      if (!camera) return { error: 'not_found' };
      return { camera };
    },

    async remove(id) {
      if (typeof id !== 'string' || !id) return { error: 'not_found' };
      if (!read(id)) return { error: 'not_found' };
      transaction(db, () => {
        deleteCred.run(id);
        deleteSnapshot.run(id);
        deleteCamera.run(id);
      });
      return { id };
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
          clearDetails.run(id);
          deleteSnapshot.run(id);
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

    async interrogate(id, options = {}) {
      if (typeof id !== 'string' || !id) return { error: 'not_found' };
      if (!read(id)) return { error: 'not_found' };
      const creds = getCred.get(id);
      if (!creds) return { error: 'not_authenticated' };
      const outcome = await runInterrogate({
        host: creds.host,
        port: creds.port,
        path: creds.path,
        scheme: creds.scheme,
        username: creds.username,
        password: creds.password
      }, options);
      if (!outcome.ok) {
        return { error: outcome.error === 'auth_failed' ? 'auth_failed' : 'unreachable' };
      }
      const profiles = outcome.profiles.map((profile) => ({ id: profile.id, label: profile.label }));
      upsertSnapshot.run(
        id,
        outcome.manufacturer,
        outcome.model,
        outcome.firmware,
        JSON.stringify(profiles),
        new Date().toISOString()
      );
      return {
        info: {
          manufacturer: outcome.manufacturer,
          model: outcome.model,
          firmware: outcome.firmware,
          profiles
        }
      };
    },

    async saveConfigured(id, input) {
      if (typeof id !== 'string' || !id) return { error: 'not_found' };
      const current = read(id);
      if (!current) return { error: 'not_found' };
      if (!getCred.get(id)) return { error: 'not_authenticated' };
      const snapshot = readSnapshot(getSnapshot, id);
      if (!snapshot) return { error: 'not_interrogated' };
      const name = cleanText(input?.name, 'name');
      const site = cleanText(input?.site, 'site', true);
      const group = cleanText(input?.group, 'group', true);
      let profileId = current.profileId ?? null;
      let profileLabel = current.profileLabel ?? null;
      if (input && Object.prototype.hasOwnProperty.call(input, 'profileId')) {
        const requested = input.profileId;
        if (requested == null || requested === '') {
          profileId = null;
          profileLabel = null;
        } else if (typeof requested !== 'string') {
          invalid();
        } else {
          const match = snapshot.profiles.find((profile) => profile.id === requested);
          if (!match) invalid();
          profileId = match.id;
          profileLabel = match.label;
        }
      }
      updateConfigured.run(
        name,
        site,
        group,
        snapshot.manufacturer,
        snapshot.model,
        profileId,
        profileLabel,
        id
      );
      const camera = read(id);
      if (!camera) return { error: 'not_found' };
      return { camera };
    },

    async runTest(id, options = {}) {
      if (typeof id !== 'string' || !id) return { error: 'not_found' };
      const current = read(id);
      if (!current) return { error: 'not_found' };
      const creds = getCred.get(id);
      if (!creds) return { error: 'not_authenticated' };
      if (current.status !== 'configured') return { error: 'not_configured' };
      const snapshot = readSnapshot(getSnapshot, id);
      if (!snapshot) return { error: 'not_configured' };
      const probe = await runDeviceProbe({
        host: creds.host,
        port: creds.port,
        path: creds.path,
        scheme: creds.scheme,
        username: creds.username,
        password: creds.password
      }, options);
      const checks = buildTestChecks(probe, snapshot);
      const summary = testSummary(checks);
      const checkedAt = new Date().toISOString();
      markTested.run(checkedAt, summary, id);
      return { cameraId: id, summary, checkedAt, checks };
    },

    async confirmReview(id) {
      if (typeof id !== 'string' || !id) return { error: 'not_found' };
      const current = read(id);
      if (!current) return { error: 'not_found' };
      const gate = onboardingGate(current);
      if (gate) return { error: gate };
      if (!isoTimestamp(current.reviewedAt)) {
        markReviewed.run(new Date().toISOString(), id);
      }
      const camera = read(id);
      if (!camera) return { error: 'not_found' };
      return { camera };
    },

    async openLive(id, options = {}) {
      if (typeof id !== 'string' || !id) return { error: 'not_found' };
      const current = read(id);
      if (!current) return { error: 'not_found' };
      const creds = getCred.get(id);
      if (!creds) return { error: 'not_authenticated' };
      if (current.status !== 'ready') return { error: 'not_ready' };
      if (typeof current.profileId !== 'string' || !current.profileId) return { error: 'missing_profile' };
      const outcome = await runGetStreamUri({
        host: creds.host,
        port: creds.port,
        path: creds.path,
        scheme: creds.scheme,
        username: creds.username,
        password: creds.password,
        profileId: current.profileId
      }, options);
      if (!outcome.ok) {
        return { error: outcome.error === 'auth_failed' ? 'auth_failed' : 'unreachable' };
      }
      return {
        cameraId: current.id,
        profileId: current.profileId,
        source: outcome.source,
        username: creds.username,
        password: creds.password
      };
    },

    async markSuccess(id) {
      if (typeof id !== 'string' || !id) return { error: 'not_found' };
      const current = read(id);
      if (!current) return { error: 'not_found' };
      const gate = onboardingGate(current);
      if (gate) return { error: gate };
      if (current.status === 'ready') return { camera: current };
      if (!isoTimestamp(current.reviewedAt)) return { error: 'not_reviewed' };
      if (current.status !== 'configured') return { error: 'not_tested' };
      markReady.run(id);
      const camera = read(id);
      if (!camera) return { error: 'not_found' };
      return { camera };
    },

    close() {
      db.close();
    }
  };
}

function ensureColumn(db, name, ddlType) {
  const columns = db.prepare('PRAGMA table_info(cameras)').all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE cameras ADD COLUMN ${name} ${ddlType}`);
  }
}

function readSnapshot(stmt, id) {
  const row = stmt.get(id);
  if (!row) return null;
  let profiles = [];
  try {
    const parsed = JSON.parse(row.profiles_json);
    if (Array.isArray(parsed)) {
      profiles = parsed
        .filter((profile) => profile && typeof profile.id === 'string' && profile.id && typeof profile.label === 'string' && profile.label)
        .map((profile) => ({ id: profile.id, label: profile.label }));
    }
  } catch {
    profiles = [];
  }
  return {
    manufacturer: typeof row.manufacturer === 'string' && row.manufacturer ? row.manufacturer : null,
    model: typeof row.model === 'string' && row.model ? row.model : null,
    firmware: typeof row.firmware === 'string' && row.firmware ? row.firmware : null,
    profiles
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

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
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

function onboardingGate(camera) {
  if (camera.lastTestSummary === 'failed') return 'test_failed';
  if (camera.lastTestSummary !== 'passed') return 'not_tested';
  if (camera.status !== 'configured' && camera.status !== 'ready') return 'not_tested';
  return null;
}

function isoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);
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
