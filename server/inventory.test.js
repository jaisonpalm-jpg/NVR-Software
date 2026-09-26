import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCameraStore } from './persistence.js';
import { startServer } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretKey = ['pass', 'word'].join('');
const userKey = ['user', 'name'].join('');
const sentinel = 'sentinel-secret-value';
const injected = 'edited-secret-value';
const firmwareMarker = 'firmware-marker-value';

const PUBLIC_KEYS = ['createdAt', 'group', 'id', 'name', 'site', 'status'];
const READY_KEYS = [
  ...PUBLIC_KEYS,
  'lastTestAt',
  'lastTestSummary',
  'manufacturer',
  'model',
  'profileId',
  'profileLabel',
  'reviewedAt'
];

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u8-'));
  return path.join(dir, 'vms.sqlite');
}

function assertForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(/pass|secret|credential|token|username|userinfo/i.test(key), false, key);
    assertForbiddenKeys(child);
  }
}

function assertNoSecrets(text) {
  const serialized = String(text);
  assert.equal(serialized.includes(sentinel), false);
  assert.equal(serialized.includes(injected), false);
  assert.equal(serialized.includes('operator'), false);
  assert.equal(serialized.includes('intruder'), false);
  assert.equal(serialized.includes(firmwareMarker), false);
  assert.equal(serialized.toLowerCase().includes(secretKey), false);
  assert.equal(serialized.toLowerCase().includes(userKey), false);
  assert.equal(/rtsp:|rtsps:|webrtc:|GetStreamUri/i.test(serialized), false);
}

async function withLogs(fn) {
  const logs = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const original = Object.fromEntries(methods.map((method) => [method, console[method]]));
  for (const method of methods) {
    console[method] = (...args) => {
      logs.push(args.map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return '';
        }
      }).join(' '));
    };
  }
  try {
    return await fn(logs);
  } finally {
    for (const method of methods) console[method] = original[method];
  }
}

async function closeServer(started) {
  started.store.close();
  await new Promise((resolve, reject) => {
    started.server.close((err) => (err ? reject(err) : resolve()));
  });
}

function withSideDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 3000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test('inventory list and edit keep the public allowlist and strip secrets', async () => {
  const dbPath = tempDb();
  await withLogs(async (logs) => {
    const started = await startServer({ port: 0, dbPath });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const empty = await fetch(`${base}/api/cameras`);
      assert.equal(empty.status, 200);
      assert.equal(await empty.text(), '[]');

      const saved = await started.store.saveAuthenticated({
        host: '192.0.2.10',
        port: 80,
        name: 'Front Door',
        [userKey]: 'operator',
        [secretKey]: sentinel
      });
      const otherRes = await fetch(`${base}/api/cameras`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Gate',
          site: 'Yard',
          group: 'Interior',
          [userKey]: 'operator',
          [secretKey]: sentinel,
          rtspUrl: `rtsp://operator:${sentinel}@192.0.2.20/stream`
        })
      });
      const otherText = await otherRes.text();
      const other = JSON.parse(otherText);
      assert.equal(otherRes.status, 201);
      assertNoSecrets(otherText);

      withSideDb(dbPath, (db) => {
        db.prepare(`
          UPDATE cameras
          SET status = 'ready', manufacturer = ?, model = ?, profile_id = ?, profile_label = ?,
            last_test_summary = 'passed', last_test_at = ?, reviewed_at = ?
          WHERE id = ?
        `).run('Acme', 'Dome', 'Profile_1', 'Main', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:01.000Z', saved.id);
        db.prepare(`
          INSERT INTO camera_device_info (camera_id, manufacturer, model, firmware, profiles_json, updated_at)
          VALUES (?, 'Acme', 'Dome', ?, '[]', '2026-09-26T00:00:00.000Z')
        `).run(saved.id, firmwareMarker);
      });

      const listedRes = await fetch(`${base}/api/cameras`);
      const listedText = await listedRes.text();
      const listed = JSON.parse(listedText);
      assert.equal(listedRes.status, 200);
      assert.equal(listed.length, 2);
      assert.equal(listed[0].id, saved.id);
      assert.equal(listed[0].status, 'ready');
      assert.equal(listed[0].manufacturer, 'Acme');
      assert.equal(listed[0].model, 'Dome');
      assert.equal(listed[0].profileLabel, 'Main');
      assert.deepEqual(Object.keys(listed[0]).sort(), READY_KEYS.sort());
      assert.deepEqual(Object.keys(listed[1]).sort(), PUBLIC_KEYS);
      assert.equal(listed[1].name, 'Gate');
      assertForbiddenKeys(listed);
      assertNoSecrets(listedText);

      const patchedRes = await fetch(`${base}/api/cameras/${saved.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Lobby',
          site: 'Main',
          group: 'Exterior',
          status: 'unknown',
          manufacturer: 'Spoofed',
          firmware: firmwareMarker,
          profileId: 'other',
          rtspUrl: `rtsp://intruder:${injected}@192.0.2.10/stream`,
          [userKey]: 'intruder',
          [secretKey]: injected
        })
      });
      const patchedText = await patchedRes.text();
      const patched = JSON.parse(patchedText);
      assert.equal(patchedRes.status, 200);
      assert.equal(patched.name, 'Lobby');
      assert.equal(patched.site, 'Main');
      assert.equal(patched.group, 'Exterior');
      assert.equal(patched.status, 'ready');
      assert.equal(patched.manufacturer, 'Acme');
      assert.equal(patched.model, 'Dome');
      assert.equal(patched.profileId, 'Profile_1');
      assert.equal(patched.profileLabel, 'Main');
      assert.deepEqual(Object.keys(patched).sort(), READY_KEYS.sort());
      assertForbiddenKeys(patched);
      assertNoSecrets(patchedText);

      const secretRow = withSideDb(dbPath, (db) => {
        return db.prepare('SELECT username, password FROM camera_credentials WHERE camera_id = ?').get(saved.id);
      });
      assert.equal(secretRow.username, 'operator');
      assert.equal(secretRow.password, sentinel);

      const kept = await (await fetch(`${base}/api/cameras/${other.id}`)).json();
      assert.equal(kept.name, 'Gate');
      assert.equal(kept.site, 'Yard');
      assert.equal(kept.group, 'Interior');
      assert.equal(kept.status, 'unknown');

      const clearedRes = await fetch(`${base}/api/cameras/${other.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          site: '',
          group: '',
          [secretKey]: injected
        })
      });
      const clearedText = await clearedRes.text();
      const cleared = JSON.parse(clearedText);
      assert.equal(clearedRes.status, 200);
      assert.equal(cleared.name, 'Gate');
      assert.equal(cleared.site, null);
      assert.equal(cleared.group, null);
      assertNoSecrets(clearedText);

      const renamedRes = await fetch(`${base}/api/cameras/${saved.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `rtsp://operator:${sentinel}@192.0.2.10/stream`
        })
      });
      const renamedText = await renamedRes.text();
      const renamed = JSON.parse(renamedText);
      assert.equal(renamedRes.status, 200);
      assert.equal(renamed.name.includes(sentinel), false);
      assert.equal(renamed.name.includes('operator'), false);
      assert.equal(renamed.name.includes('192.0.2.10'), true);
      assert.equal(renamed.status, 'ready');
      assert.equal(renamedText.includes(sentinel), false);
      assert.equal(renamedText.includes(injected), false);
      assert.equal(renamedText.includes('operator'), false);
      assert.equal(renamedText.toLowerCase().includes(secretKey), false);
      assert.equal(renamedText.toLowerCase().includes(userKey), false);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(injected) || line.includes('operator') || line.includes('intruder')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('inventory delete removes the camera, stored login, and stream claim', async () => {
  const dbPath = tempDb();
  await withLogs(async (logs) => {
    const started = await startServer({ port: 0, dbPath });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const saved = await started.store.saveAuthenticated({
        host: '192.0.2.11',
        port: 80,
        name: 'Dock',
        [userKey]: 'operator',
        [secretKey]: sentinel
      });
      const other = await started.store.create({ name: 'Gate', site: 'Yard', group: 'Interior' });
      withSideDb(dbPath, (db) => {
        db.prepare(`UPDATE cameras SET status = 'ready', profile_id = 'Profile_1', profile_label = 'Main' WHERE id = ?`).run(saved.id);
        db.prepare(`
          INSERT INTO camera_device_info (camera_id, manufacturer, model, firmware, profiles_json, updated_at)
          VALUES (?, 'Acme', 'Dome', ?, '[]', '2026-09-26T00:00:00.000Z')
        `).run(saved.id, firmwareMarker);
      });

      const removedRes = await fetch(`${base}/api/cameras/${saved.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          [userKey]: 'intruder',
          [secretKey]: injected,
          rtspUrl: `rtsp://intruder:${injected}@192.0.2.11/stream`
        })
      });
      const removedText = await removedRes.text();
      const removed = JSON.parse(removedText);
      assert.equal(removedRes.status, 200);
      assert.deepEqual(removed, { ok: true, deleted: true, id: saved.id });
      assertForbiddenKeys(removed);
      assertNoSecrets(removedText);

      const missing = await fetch(`${base}/api/cameras/${saved.id}`);
      const missingText = await missing.text();
      assert.equal(missing.status, 404);
      assert.equal(JSON.parse(missingText).error, 'not_found');
      assertNoSecrets(missingText);

      const stream = await fetch(`${base}/api/cameras/${saved.id}/stream`);
      const streamText = await stream.text();
      const streamBody = JSON.parse(streamText);
      assert.equal(stream.status, 404);
      assert.equal(streamBody.ok, false);
      assert.equal(streamBody.contract, 'onvif.stream.v0');
      assert.equal(streamBody.error, 'not_found');
      assertNoSecrets(streamText);

      const live = await fetch(`${base}/api/cameras/${saved.id}/live`);
      const liveText = await live.text();
      assert.equal(live.status, 404);
      assert.equal(JSON.parse(liveText).error, 'not_found');
      assertNoSecrets(liveText);

      const listed = await (await fetch(`${base}/api/cameras`)).json();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, other.id);
      assert.equal(listed[0].name, 'Gate');
      assertNoSecrets(JSON.stringify(listed));

      const left = withSideDb(dbPath, (db) => ({
        cameras: db.prepare('SELECT id FROM cameras WHERE id = ?').get(saved.id),
        creds: db.prepare('SELECT password FROM camera_credentials WHERE camera_id = ?').get(saved.id),
        info: db.prepare('SELECT firmware FROM camera_device_info WHERE camera_id = ?').get(saved.id)
      }));
      assert.equal(left.cameras, undefined);
      assert.equal(left.creds, undefined);
      assert.equal(left.info, undefined);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(injected) || line.includes('operator') || line.includes('intruder')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('inventory rejects a bad edit and an unknown id without echoing secrets', async () => {
  await withLogs(async (logs) => {
    const started = await startServer({ port: 0, dbPath: tempDb() });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const created = await started.store.create({ name: 'Dock', site: 'Main', group: 'Exterior' });
      const blank = await fetch(`${base}/api/cameras/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '   ',
          [userKey]: 'operator',
          [secretKey]: sentinel
        })
      });
      const blankText = await blank.text();
      assert.equal(blank.status, 400);
      assert.deepEqual(JSON.parse(blankText), { ok: false, error: 'invalid_request' });
      assertNoSecrets(blankText);

      const still = await (await fetch(`${base}/api/cameras/${created.id}`)).json();
      assert.equal(still.name, 'Dock');

      const missing = await fetch(`${base}/api/cameras/missing-camera`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Lobby',
          [userKey]: 'intruder',
          [secretKey]: injected,
          rtspUrl: `rtsp://intruder:${injected}@192.0.2.10/stream`
        })
      });
      const missingText = await missing.text();
      assert.equal(missing.status, 404);
      assert.deepEqual(JSON.parse(missingText), { ok: false, error: 'not_found' });
      assertNoSecrets(missingText);

      const gone = await fetch(`${base}/api/cameras/missing-camera`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [secretKey]: sentinel, [userKey]: 'operator' })
      });
      const goneText = await gone.text();
      assert.equal(gone.status, 404);
      assert.deepEqual(JSON.parse(goneText), { ok: false, error: 'not_found' });
      assertNoSecrets(goneText);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(injected) || line.includes('operator') || line.includes('intruder')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('the cameras page inventories rows and does not collect a login', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<th>Name<\/th>\s*<th>Site<\/th>\s*<th>Group<\/th>\s*<th>Status<\/th>\s*<th>Device<\/th>/);
  assert.match(html, /No cameras saved/);
  assert.match(html, /Add a camera from the wizard\. Live View lists a camera only when its status is ready\./);
  assert.match(html, /method: 'PATCH'/);
  assert.match(html, /method: 'DELETE'/);
  assert.match(html, /function releaseLiveCamera\(id\)/);
  assert.match(html, /frame\.removeAttribute\('src'\)/);
  assert.match(html, /article\.dataset\.cameraId = camera\.id/);
  assert.match(html, /ready: 'pill green'/);
  assert.match(html, /authenticated: 'pill green'/);
  assert.match(html, /configured: 'pill green'/);
  assert.match(html, /unknown: 'pill gray'/);
  assert.match(html, /class="setup-grid wizard-steps"/);
  assert.match(html, /--blue:\s*#2f6bff/);
  const editStart = html.indexOf('id="edit-camera-form"');
  const editEnd = html.indexOf('id="removeCameraModal"');
  const editForm = html.slice(editStart, editEnd);
  assert.equal(editStart > 0 && editEnd > editStart, true);
  assert.match(editForm, /id="edit-camera-name"/);
  assert.match(editForm, /id="edit-camera-site"/);
  assert.match(editForm, /id="edit-camera-group"/);
  assert.equal(/type="password"|name="password"|name="username"/i.test(editForm), false);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  assert.equal(html.includes('result.textContent = data'), false);
  assert.equal(html.includes('result.textContent = JSON.stringify'), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(html), false);
  assert.equal(/GetStreamUri|rtsp:|webrtc/i.test(html), false);
  assert.equal(html.includes(sentinel), false);
  const primary = html.match(/\.btn-primary \{[^}]+\}/);
  assert.match(primary[0], /background:\s*var\(--blue\)/);
  assert.equal(primary[0].includes('--green'), false);
});
