import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './index.js';
import {
  acceptDeviceInfo,
  buildOnvifEnvelope,
  callDeviceCapabilities,
  mediaServiceUrl,
  parseProfiles
} from './onvif-interrogate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretKey = ['pass', 'word'].join('');
const userKey = ['user', 'name'].join('');
const sentinel = 'sentinel-secret-value';
const bodySecret = 'body-secret-not-stored';
const PUBLIC_KEYS = ['createdAt', 'group', 'id', 'name', 'site', 'status'];

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u3-'));
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
  assert.equal(serialized.includes(bodySecret), false);
  assert.equal(serialized.includes('operator'), false);
  assert.equal(serialized.includes('body-user-not-stored'), false);
  assert.equal(serialized.toLowerCase().includes(secretKey), false);
  assert.equal(serialized.toLowerCase().includes(userKey), false);
  assert.equal(/rtsp:|webrtc:|GetStreamUri/i.test(serialized), false);
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

function authBody() {
  return {
    host: '192.0.2.10',
    port: 80,
    path: '/onvif/device_service',
    scheme: 'http',
    name: 'Front Door',
    [userKey]: 'operator',
    [secretKey]: sentinel
  };
}

function deviceXml() {
  return `<tds:GetDeviceInformationResponse>
    <tds:Manufacturer>Acme</tds:Manufacturer>
    <tds:Model>Cam-100</tds:Model>
    <tds:FirmwareVersion>fw-build-9</tds:FirmwareVersion>
    <tds:SerialNumber>${sentinel}</tds:SerialNumber>
    <tds:HardwareId>rtsp://operator:${sentinel}@192.0.2.10/stream</tds:HardwareId>
  </tds:GetDeviceInformationResponse>`;
}

function capabilitiesXml(mediaUrl) {
  return `<tds:GetCapabilitiesResponse><tds:Capabilities>
    <tt:Device><tt:XAddr>http://192.0.2.99/onvif/device_service</tt:XAddr></tt:Device>
    <tt:Media><tt:XAddr>${mediaUrl}</tt:XAddr></tt:Media>
  </tds:Capabilities></tds:GetCapabilitiesResponse>`;
}

function profilesXml() {
  return `<trt:GetProfilesResponse>
    <trt:Profiles token="Profile_1">
      <tt:Name>Main</tt:Name>
      <tt:URI>rtsp://operator:${sentinel}@192.0.2.10/stream</tt:URI>
    </trt:Profiles>
    <trt:Profiles token="${sentinel}">
      <tt:Name>Hidden</tt:Name>
    </trt:Profiles>
  </trt:GetProfilesResponse>`;
}

function scriptedFetch(mediaUrl) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: String(options && options.body || '') });
    const body = calls[calls.length - 1].body;
    if (body.includes('GetStreamUri')) {
      return { status: 500, async text() { return sentinel; } };
    }
    if (body.includes('GetDeviceInformation')) {
      return { status: 200, async text() { return deviceXml(); } };
    }
    if (body.includes('GetCapabilities')) {
      return { status: 200, async text() { return capabilitiesXml(mediaUrl); } };
    }
    if (body.includes('GetProfiles')) {
      return { status: 200, async text() { return profilesXml(); } };
    }
    return { status: 500, async text() { return `<s:Fault>${sentinel}</s:Fault>`; } };
  };
  return { calls, fetchImpl };
}

async function authenticate(base) {
  const response = await fetch(`${base}/api/onvif/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(authBody())
  });
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.equal(body.authenticated, true);
  assertNoSecrets(text);
  return body.cameraId;
}

test('capability envelopes digest the password and do not ask for a stream', () => {
  const nonce = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const created = '2020-01-01T00:00:00.000Z';
  const expected = createHash('sha1').update(Buffer.concat([
    nonce,
    Buffer.from(created, 'utf8'),
    Buffer.from(sentinel, 'utf8')
  ])).digest('base64');
  const xml = buildOnvifEnvelope('operator', sentinel, '<trt:GetProfiles/>', { nonce, created });
  assert.equal(xml.includes(expected), true);
  assert.equal(xml.includes(sentinel), false);
  assert.equal(xml.includes('GetProfiles'), true);
  assert.equal(xml.includes('GetCapabilities') || xml.includes('GetDeviceInformation'), false);
  assert.equal(/GetStreamUri|rtsp:|webrtc/i.test(xml), false);
});

test('profile parsing keeps names and a same-host media address drops userinfo', () => {
  const profiles = parseProfiles(profilesXml());
  assert.equal(profiles[0].id, 'Profile_1');
  assert.equal(profiles[0].label, 'Main');
  assert.equal(/rtsp:/i.test(profiles[0].label), false);
  const clean = acceptDeviceInfo({ profiles }, ['operator', sentinel]);
  assert.deepEqual(clean.profiles, [{ id: 'Profile_1', label: 'Main' }]);
  assertNoSecrets(JSON.stringify(clean));

  const foreign = mediaServiceUrl(capabilitiesXml('http://192.0.2.99/onvif/media_service'), { host: '192.0.2.10' });
  assert.equal(foreign, null);
  const local = mediaServiceUrl(
    capabilitiesXml(`http://operator:${sentinel}@192.0.2.10/onvif/media_service`),
    { host: '192.0.2.10' }
  );
  assert.equal(local, 'http://192.0.2.10/onvif/media_service');
  assert.equal(local.includes(sentinel), false);
  assert.equal(local.includes('operator'), false);
});

test('device info from a client cannot carry secrets into the public result', () => {
  const clean = acceptDeviceInfo({
    manufacturer: `Acme ${sentinel}`,
    model: 'Cam-100',
    firmware: 'fw-build-9',
    [userKey]: 'operator',
    [secretKey]: sentinel,
    uri: `rtsp://operator:${sentinel}@192.0.2.10/stream`,
    profiles: [
      { token: 'Profile_1', name: 'Main', uri: `rtsp://operator:${sentinel}@192.0.2.10/stream` },
      { id: sentinel, label: 'Hidden' }
    ]
  }, ['operator', sentinel]);
  assert.equal(clean.manufacturer, 'Acme');
  assert.deepEqual(clean.profiles, [{ id: 'Profile_1', label: 'Main' }]);
  assertNoSecrets(JSON.stringify(clean));
  assertForbiddenKeys(clean);
});

test('the device client calls device and same-host media services without a stream URI', async () => {
  const { calls, fetchImpl } = scriptedFetch(`http://operator:${sentinel}@192.0.2.10:80/onvif/media_service`);
  const result = await callDeviceCapabilities({
    scheme: 'http',
    host: '192.0.2.10',
    port: 80,
    path: '/onvif/device_service',
    [userKey]: 'operator',
    [secretKey]: sentinel
  }, { timeoutMs: 400, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.manufacturer, 'Acme');
  assert.equal(result.model, 'Cam-100');
  assert.deepEqual(result.profiles, [{ id: 'Profile_1', label: 'Main' }]);
  assertNoSecrets(JSON.stringify(result));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://192.0.2.10:80/onvif/device_service');
  assert.equal(calls[2].url, 'http://192.0.2.10/onvif/media_service');
  assert.equal(calls.some((call) => call.body.includes('GetDeviceInformation')), true);
  assert.equal(calls.some((call) => call.body.includes('GetCapabilities')), true);
  assert.equal(calls.some((call) => call.body.includes('GetProfiles')), true);
  assert.equal(calls.some((call) => /GetStreamUri|rtsp:/i.test(call.body) || call.body.includes(sentinel)), false);
  assert.equal(calls.some((call) => call.url.includes(sentinel) || call.url.includes('operator')), false);
});

test('a non-routable interrogation is unreachable and returns no secrets', async () => {
  const result = await callDeviceCapabilities({
    scheme: 'http',
    host: '192.0.2.1',
    port: 80,
    path: '/onvif/device_service',
    [userKey]: 'operator',
    [secretKey]: sentinel
  }, { timeoutMs: 400 });
  assert.deepEqual(result, { ok: false, error: 'unreachable' });
  assertNoSecrets(JSON.stringify(result));
});

test('failed interrogation does not leak, store a snapshot, or change status', async () => {
  const dbPath = tempDb();
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath,
      authOptions: { client: async () => ({ ok: true }) },
      interrogateOptions: {
        client: async (target) => {
          throw new Error(`rejected ${target.password} ${target.username} ${sentinel}`);
        }
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const cameraId = await authenticate(base);
      const response = await fetch(`${base}/api/cameras/${cameraId}/interrogate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          [userKey]: 'body-user-not-stored',
          [secretKey]: bodySecret,
          rtspUrl: `rtsp://operator:${sentinel}@192.0.2.10/stream`
        })
      });
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 502);
      assert.deepEqual(body, {
        ok: false,
        contract: 'onvif.interrogate.v0',
        error: 'unreachable'
      });
      assertForbiddenKeys(body);
      assertNoSecrets(text);

      const listedText = await (await fetch(`${base}/api/cameras`)).text();
      const listed = JSON.parse(listedText);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].status, 'authenticated');
      assert.deepEqual(Object.keys(listed[0]).sort(), PUBLIC_KEYS);
      assertNoSecrets(listedText);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(bodySecret) || line.includes('operator')), false);

      const raw = fs.readFileSync(dbPath);
      assert.equal(raw.includes(Buffer.from(sentinel)), true);
      assert.equal(raw.includes(Buffer.from(bodySecret)), false);
      assert.equal(raw.includes(Buffer.from('camera_device_info')), true);
    } finally {
      await closeServer(started);
    }
  });
});

test('a rejected stored login does not echo the device fault', async () => {
  const dbPath = tempDb();
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath,
      authOptions: { client: async () => ({ ok: true }) },
      interrogateOptions: {
        client: async (target) => ({
          ok: false,
          error: 'auth_failed',
          [userKey]: target.username,
          [secretKey]: target.password,
          detail: `NotAuthorized ${sentinel}`
        })
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const cameraId = await authenticate(base);
      const response = await fetch(`${base}/api/cameras/${cameraId}/interrogate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      const text = await response.text();
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(text), {
        ok: false,
        contract: 'onvif.interrogate.v0',
        error: 'auth_failed'
      });
      assertNoSecrets(text);
      const listed = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
      assert.equal(listed.status, 'authenticated');
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('configure save persists non-secret fields and leaves the stream unavailable', async () => {
  const dbPath = tempDb();
  let seenUser = '';
  let seenSecret = '';
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath,
      authOptions: {
        client: async () => ({ ok: true, [secretKey]: sentinel, rtspUrl: `rtsp://operator:${sentinel}@192.0.2.10/stream` })
      },
      interrogateOptions: {
        client: async (target) => {
          seenUser = target.username;
          seenSecret = target.password;
          return {
            ok: true,
            manufacturer: 'Acme',
            model: 'Cam-100',
            firmware: 'fw-build-9',
            [userKey]: target.username,
            [secretKey]: target.password,
            profiles: [
              { token: 'Profile_1', name: 'Main', uri: `rtsp://operator:${sentinel}@192.0.2.10/stream` },
              { id: sentinel, label: 'Hidden' }
            ]
          };
        }
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const before = await fetch(`${base}/api/onvif/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 100, host: '192.0.2.10', [secretKey]: sentinel })
      });
      const beforeText = await before.text();
      const beforeBody = JSON.parse(beforeText);
      assert.equal(before.status, 200);
      assert.equal(beforeBody.implemented, true);
      assert.ok(Array.isArray(beforeBody.devices));
      assertNoSecrets(beforeText);
      assert.equal(await (await fetch(`${base}/api/cameras`)).text(), '[]');

      const cameraId = await authenticate(base);
      const authShape = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
      assert.equal(authShape.status, 'authenticated');
      assert.deepEqual(Object.keys(authShape).sort(), PUBLIC_KEYS);

      const early = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Gate', site: 'Main', group: 'Exterior', profileId: 'Profile_1' })
      });
      const earlyText = await early.text();
      assert.equal(early.status, 409);
      assert.equal(JSON.parse(earlyText).error, 'not_interrogated');
      assertNoSecrets(earlyText);
      assert.equal((await (await fetch(`${base}/api/cameras/${cameraId}`)).json()).status, 'authenticated');

      const read = await fetch(`${base}/api/cameras/${cameraId}/interrogate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          [userKey]: 'body-user-not-stored',
          [secretKey]: bodySecret
        })
      });
      const readText = await read.text();
      const readBody = JSON.parse(readText);
      assert.equal(read.status, 200);
      assert.equal(readBody.ok, true);
      assert.equal(readBody.contract, 'onvif.interrogate.v0');
      assert.equal(readBody.cameraId, cameraId);
      assert.equal(readBody.manufacturer, 'Acme');
      assert.equal(readBody.model, 'Cam-100');
      assert.equal(readBody.firmware, 'fw-build-9');
      assert.deepEqual(readBody.profiles, [{ id: 'Profile_1', label: 'Main' }]);
      assertForbiddenKeys(readBody);
      assertNoSecrets(readText);
      assert.equal(seenUser === 'operator', true);
      assert.equal(seenSecret === sentinel, true);
      assert.equal((await (await fetch(`${base}/api/cameras/${cameraId}`)).json()).status, 'authenticated');

      const missing = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Gate', profileId: 'missing' })
      });
      assert.equal(missing.status, 400);
      assertNoSecrets(await missing.text());

      const saved = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Gate',
          site: 'Main',
          group: 'Exterior',
          profileId: 'Profile_1',
          [userKey]: 'body-user-not-stored',
          [secretKey]: bodySecret,
          rtspUrl: `rtsp://operator:${sentinel}@192.0.2.10/stream`,
          firmware: 'fw-build-9'
        })
      });
      const savedText = await saved.text();
      const savedBody = JSON.parse(savedText);
      assert.equal(saved.status, 200);
      assert.equal(savedBody.ok, true);
      assert.equal(savedBody.contract, 'onvif.configure.v0');
      assert.equal(savedBody.camera.status, 'configured');
      assert.equal(savedBody.camera.name, 'Gate');
      assert.equal(savedBody.camera.site, 'Main');
      assert.equal(savedBody.camera.group, 'Exterior');
      assert.equal(savedBody.camera.manufacturer, 'Acme');
      assert.equal(savedBody.camera.model, 'Cam-100');
      assert.equal(savedBody.camera.profileId, 'Profile_1');
      assert.equal(savedBody.camera.profileLabel, 'Main');
      assert.equal(savedBody.camera.firmware, undefined);
      assertForbiddenKeys(savedBody);
      assertNoSecrets(savedText);

      const listedText = await (await fetch(`${base}/api/cameras`)).text();
      const listed = JSON.parse(listedText);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].status, 'configured');
      assert.equal(listed[0].profileLabel, 'Main');
      assert.equal(Object.hasOwn(listed[0], 'firmware'), false);
      assert.equal(listedText.includes('fw-build-9'), false);
      assertForbiddenKeys(listed[0]);
      assertNoSecrets(listedText);

      const oneText = await (await fetch(`${base}/api/cameras/${cameraId}`)).text();
      assert.equal(JSON.parse(oneText).name, 'Gate');
      assertNoSecrets(oneText);

      const streamRes = await fetch(`${base}/api/cameras/${cameraId}/stream`);
      const streamText = await streamRes.text();
      const stream = JSON.parse(streamText);
      assert.equal(streamRes.status, 409);
      assert.equal(stream.ok, false);
      assert.equal(stream.contract, 'onvif.stream.v0');
      assert.equal(stream.error, 'not_ready');
      assertNoSecrets(streamText);

      const kept = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Gate East', site: 'Main', group: 'Exterior' })
      });
      const keptBody = await kept.json();
      assert.equal(kept.status, 200);
      assert.equal(keptBody.camera.name, 'Gate East');
      assert.equal(keptBody.camera.profileId, 'Profile_1');
      assertNoSecrets(JSON.stringify(keptBody));

      const probe = await fetch(`${base}/api/onvif/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      const probeText = await probe.text();
      const probeBody = JSON.parse(probeText);
      assert.equal(probe.status, 400);
      assert.equal(probeBody.implemented, true);
      assert.equal(probeBody.error, 'invalid_request');
      assertNoSecrets(probeText);
      assertForbiddenKeys(probeBody);

      const again = await fetch(`${base}/api/onvif/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authBody())
      });
      const againBody = await again.json();
      assert.equal(againBody.cameraId, cameraId);
      assertNoSecrets(JSON.stringify(againBody));
      const reset = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
      assert.equal(reset.status, 'authenticated');
      assert.deepEqual(Object.keys(reset).sort(), PUBLIC_KEYS);

      const afterReset = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Gate East', site: 'Main', group: 'Exterior' })
      });
      assert.equal(afterReset.status, 409);
      assert.equal((await afterReset.json()).error, 'not_interrogated');

      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(bodySecret) || line.includes('operator')), false);
      const raw = fs.readFileSync(dbPath);
      assert.equal(raw.includes(Buffer.from(sentinel)), true);
      assert.equal(raw.includes(Buffer.from(bodySecret)), false);
      assert.equal(raw.includes(Buffer.from('rtsp://')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('configure and interrogate reject cameras that have no stored login', async () => {
  await withLogs(async (logs) => {
    const started = await startServer({ port: 0, dbPath: tempDb() });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const created = await (await fetch(`${base}/api/cameras`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Manual',
          site: 'Main',
          [userKey]: 'operator',
          [secretKey]: sentinel
        })
      })).json();
      assert.equal(created.status, 'unknown');
      assert.deepEqual(Object.keys(created).sort(), PUBLIC_KEYS);

      const read = await fetch(`${base}/api/cameras/${created.id}/interrogate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [secretKey]: sentinel })
      });
      const readText = await read.text();
      assert.equal(read.status, 409);
      assert.equal(JSON.parse(readText).error, 'not_authenticated');
      assertNoSecrets(readText);

      const saved = await fetch(`${base}/api/cameras/${created.id}/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Manual', [secretKey]: sentinel })
      });
      const savedText = await saved.text();
      assert.equal(saved.status, 409);
      assert.equal(JSON.parse(savedText).error, 'not_authenticated');
      assertNoSecrets(savedText);
      assert.equal((await (await fetch(`${base}/api/cameras/${created.id}`)).json()).status, 'unknown');

      const missing = await fetch(`${base}/api/cameras/missing/interrogate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(missing.status, 404);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('fetch-backed interrogation stores only the scrubbed device info', async () => {
  const dbPath = tempDb();
  const { calls, fetchImpl } = scriptedFetch('http://192.0.2.10/onvif/media_service');
  const started = await startServer({
    port: 0,
    dbPath,
    authOptions: { client: async () => ({ ok: true }) },
    interrogateOptions: { fetchImpl, timeoutMs: 400 }
  });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const cameraId = await authenticate(base);
    const response = await fetch(`${base}/api/cameras/${cameraId}/interrogate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.equal(body.manufacturer, 'Acme');
    assert.equal(body.model, 'Cam-100');
    assert.deepEqual(body.profiles, [{ id: 'Profile_1', label: 'Main' }]);
    assertNoSecrets(text);
    assert.equal(calls.length, 3);
    assert.equal(calls.some((call) => call.body.includes(sentinel) || /GetStreamUri|rtsp:/i.test(call.body)), false);

    const saved = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Gate', site: 'Yard', group: 'North', profileId: '' })
    });
    const savedBody = await saved.json();
    assert.equal(savedBody.camera.status, 'configured');
    assert.equal(savedBody.camera.profileId, undefined);
    assert.equal(savedBody.camera.manufacturer, 'Acme');
    assertNoSecrets(JSON.stringify(savedBody));
  } finally {
    await closeServer(started);
  }
});

test('the cameras page configures without asking for the password again', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const formStart = html.indexOf('id="configure-form"');
  const formEnd = html.indexOf('id="test-btn"');
  const form = html.slice(formStart, formEnd);
  assert.equal(formStart > 0, true);
  assert.match(html, /\/interrogate/);
  assert.match(html, /\/configure/);
  assert.match(html, /Read device/);
  assert.match(html, /Save configuration/);
  assert.match(html, /Configuration saved\. No stream was opened\./);
  assert.match(html, /Read the device before saving\./);
  assert.match(html, /Authenticated\. The login stays on the server\./);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  assert.equal(/type="password"|name="password"|name="username"/i.test(form), false);
  assert.equal(html.includes('result.textContent = data'), false);
  assert.equal(html.includes('result.textContent = JSON.stringify'), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(html), false);
  assert.equal(html.includes(sentinel), false);
  assert.equal(/GetStreamUri|MediaMTX|go2rtc|webrtc/i.test(html), false);
});
