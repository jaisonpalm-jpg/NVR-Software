import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCameraStore } from './persistence.js';
import { startServer } from './index.js';

const secretKey = ['pass', 'word'].join('');
const userKey = ['user', 'name'].join('');
const sentinel = 'sentinel-secret-value';

function assertForbiddenKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(/pass|secret|credential|token|username|userinfo/i.test(key), false, key);
    assertForbiddenKeys(child);
  }
}

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u0-'));
  return path.join(dir, 'vms.sqlite');
}

test('a new store lists no cameras', async () => {
  const store = createCameraStore(tempDb());
  try {
    assert.deepEqual(await store.list(), []);
  } finally {
    store.close();
  }
});

test('public camera records omit secret material and survive reopen', async () => {
  const dbPath = tempDb();
  const store = createCameraStore(dbPath);
  const created = await store.create({
    name: 'Dock',
    site: 'Main',
    group: 'Exterior',
    status: 'online',
    [userKey]: 'operator',
    [secretKey]: sentinel,
    rtspUrl: `rtsp://operator:${sentinel}@192.168.1.10/stream`
  });
  store.close();

  const reopened = createCameraStore(dbPath);
  try {
    const listed = await reopened.list();
    const one = await reopened.get(created.id);
    const serialized = JSON.stringify({ created, listed, one });
    assert.equal(listed.length, 1);
    assert.deepEqual(Object.keys(created).sort(), ['createdAt', 'group', 'id', 'name', 'site', 'status']);
    assert.equal(created.status, 'unknown');
    assert.equal(one.name, 'Dock');
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes('operator'), false);
    assert.equal(serialized.includes('rtsp'), false);
    assert.equal(serialized.toLowerCase().includes(secretKey), false);
    assert.equal(serialized.toLowerCase().includes(userKey), false);
    const raw = fs.readFileSync(dbPath);
    assert.equal(raw.includes(Buffer.from(sentinel)), false);
    assert.equal(raw.includes(Buffer.from('operator')), false);
  } finally {
    reopened.close();
  }
});

test('userinfo in a camera name is removed before save', async () => {
  const store = createCameraStore(tempDb());
  try {
    const created = await store.create({
      name: `rtsp://operator:${sentinel}@192.168.1.50/stream`,
      site: 'Yard'
    });
    assert.equal(created.name.includes(sentinel), false);
    assert.equal(created.name.includes('operator'), false);
    assert.equal(created.name.includes('192.168.1.50'), true);
  } finally {
    store.close();
  }
});

test('camera routes stay sanitized and discover does not echo secrets', async () => {
  const started = await startServer({ port: 0, dbPath: tempDb() });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const list = await fetch(`${base}/api/cameras`);
    assert.equal(list.status, 200);
    assert.equal(await list.text(), '[]');

    const beforeDiscover = await fetch(`${base}/api/cameras`);
    assert.equal(await beforeDiscover.text(), '[]');

    const discover = await fetch(`${base}/api/onvif/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timeoutMs: 100,
        host: '192.0.2.10',
        [userKey]: 'operator',
        [secretKey]: sentinel
      })
    });
    const discoverText = await discover.text();
    const discoverBody = JSON.parse(discoverText);
    assert.equal(discover.status, 200);
    assert.equal(discoverBody.ok, true);
    assert.equal(discoverBody.contract, 'onvif.discover.v0');
    assert.equal(discoverBody.implemented, true);
    assert.ok(Array.isArray(discoverBody.devices));
    assert.equal(discoverText.includes(sentinel), false);
    assert.equal(discoverText.includes('operator'), false);
    assertForbiddenKeys(discoverBody);

    const afterDiscover = await fetch(`${base}/api/cameras`);
    assert.equal(await afterDiscover.text(), '[]');

    const createdRes = await fetch(`${base}/api/cameras`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Gate',
        site: 'Main',
        [userKey]: 'operator',
        [secretKey]: sentinel
      })
    });
    const createdText = await createdRes.text();
    assert.equal(createdRes.status, 201);
    const created = JSON.parse(createdText);
    assert.equal(created.name, 'Gate');
    assert.equal(createdText.includes(sentinel), false);
    assert.equal(createdText.includes('operator'), false);

    const fetched = await fetch(`${base}/api/cameras/${created.id}`);
    const fetchedText = await fetched.text();
    assert.equal(fetched.status, 200);
    assert.equal(fetchedText.includes(sentinel), false);

    const stream = await fetch(`${base}/api/cameras/${created.id}/stream`);
    const streamText = await stream.text();
    assert.equal(stream.status, 409);
    const streamBody = JSON.parse(streamText);
    assert.equal(streamBody.ok, false);
    assert.equal(streamBody.contract, 'onvif.stream.v0');
    assert.equal(streamBody.error, 'not_authenticated');
    assert.equal(streamText.includes(sentinel), false);
    assert.equal(streamText.includes('rtsp://'), false);

    const probe = await fetch(`${base}/api/onvif/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [secretKey]: sentinel })
    });
    const probeText = await probe.text();
    const probeBody = JSON.parse(probeText);
    assert.equal(probe.status, 400);
    assert.equal(probeBody.implemented, true);
    assert.equal(probeBody.error, 'invalid_request');
    assert.equal(probeText.includes(sentinel), false);
    assertForbiddenKeys(probeBody);

    const listed = await fetch(`${base}/api/cameras`);
    const listedBody = await listed.json();
    assert.equal(listedBody.length, 1);
    assert.equal(JSON.stringify(listedBody).includes(sentinel), false);
  } finally {
    started.store.close();
    await new Promise((resolve, reject) => {
      started.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
