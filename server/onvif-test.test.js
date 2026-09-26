import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './index.js';
import { buildTestChecks, runDeviceProbe, testSummary } from './onvif-test.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretKey = ['pass', 'word'].join('');
const userKey = ['user', 'name'].join('');
const sentinel = 'sentinel-secret-value';
const bodySecret = 'body-secret-not-stored';
const PUBLIC_KEYS = ['createdAt', 'group', 'id', 'name', 'site', 'status'];
const MEDIA = ['mainStream', 'substream', 'ptz', 'audio', 'events'];

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u4-'));
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
  </tds:GetDeviceInformationResponse>`;
}

async function configureCamera(base, interrogateBody) {
  const authed = await fetch(`${base}/api/onvif/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(authBody())
  });
  const authedBody = await authed.json();
  assert.equal(authed.status, 200);
  const cameraId = authedBody.cameraId;
  const read = await fetch(`${base}/api/cameras/${cameraId}/interrogate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(read.status, 200);
  const saved = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Gate',
      site: 'Main',
      group: 'Exterior',
      ...(interrogateBody || { profileId: 'Profile_1' })
    })
  });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(savedBody.camera.status, 'configured');
  return cameraId;
}

function checkMap(checks) {
  return Object.fromEntries(checks.map((item) => [item.name, item]));
}

test('media checks stay skipped and a passing probe does not open a stream', () => {
  const checks = buildTestChecks(
    { network: 'pass', authentication: 'pass', onvif: 'pass', [secretKey]: sentinel },
    { manufacturer: 'Acme', model: 'Cam-100', profiles: [{ id: 'Profile_1', label: 'Main' }] }
  );
  assert.equal(testSummary(checks), 'passed');
  const mapped = checkMap(checks);
  assert.equal(mapped.network.status, 'pass');
  assert.equal(mapped.authentication.status, 'pass');
  assert.equal(mapped.onvif.status, 'pass');
  assert.equal(mapped.deviceInfo.status, 'pass');
  for (const name of MEDIA) {
    assert.equal(mapped[name].status, 'skipped');
    assert.equal(mapped[name].reason, 'not_implemented');
  }
  assertNoSecrets(JSON.stringify(checks));
  assertForbiddenKeys(checks);
});

test('a non-routable probe fails network and does not call the device service', async () => {
  let fetched = false;
  const probe = await runDeviceProbe({
    scheme: 'http',
    host: '192.0.2.1',
    port: 80,
    path: '/onvif/device_service',
    [userKey]: 'operator',
    [secretKey]: sentinel
  }, {
    timeoutMs: 300,
    fetchImpl: async () => {
      fetched = true;
      return { status: 200, async text() { return deviceXml(); } };
    }
  });
  assert.deepEqual(probe, { network: 'fail', authentication: 'fail', onvif: 'fail' });
  assert.equal(fetched, false);
  assertNoSecrets(JSON.stringify(probe));
});

test('test uses the stored login and skips media checks', async () => {
  const dbPath = tempDb();
  const calls = [];
  let seenUser = '';
  let seenSecret = '';
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath,
      authOptions: { client: async () => ({ ok: true }) },
      interrogateOptions: {
        client: async () => ({
          ok: true,
          manufacturer: 'Acme',
          model: 'Cam-100',
          firmware: 'fw-build-9',
          profiles: [{ token: 'Profile_1', name: 'Main' }]
        })
      },
      testOptions: {
        connectImpl: async () => true,
        timeoutMs: 400,
        fetchImpl: async (url, options) => {
          const body = String(options && options.body || '');
          calls.push({ url: String(url), body });
          if (body.includes('GetDeviceInformation')) {
            return { status: 200, async text() { return deviceXml(); } };
          }
          return { status: 500, async text() { return `<s:Fault>${sentinel}</s:Fault>`; } };
        }
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const discover = await fetch(`${base}/api/onvif/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeoutMs: 100, host: '192.0.2.10' })
      });
      const discoverBody = await discover.json();
      assert.equal(discover.status, 200);
      assert.equal(discoverBody.implemented, true);
      assert.ok(Array.isArray(discoverBody.devices));

      const cameraId = await configureCamera(base);
      const response = await fetch(`${base}/api/cameras/${cameraId}/test`, {
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
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.contract, 'onvif.test.v0');
      assert.equal(body.implemented, true);
      assert.equal(body.cameraId, cameraId);
      assert.equal(body.summary, 'passed');
      assert.match(body.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
      const mapped = checkMap(body.checks);
      assert.equal(mapped.network.status, 'pass');
      assert.equal(mapped.authentication.status, 'pass');
      assert.equal(mapped.onvif.status, 'pass');
      assert.equal(mapped.deviceInfo.status, 'pass');
      assert.equal(mapped.deviceInfo.reason, undefined);
      for (const name of MEDIA) {
        assert.equal(mapped[name].status, 'skipped');
        assert.equal(mapped[name].reason, 'not_implemented');
      }
      assertForbiddenKeys(body);
      assertNoSecrets(text);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://192.0.2.10:80/onvif/device_service');
      assert.equal(calls[0].body.includes('GetDeviceInformation'), true);
      assert.equal(calls[0].body.includes(sentinel), false);
      assert.equal(/GetStreamUri|GetProfiles|rtsp:/i.test(calls[0].body), false);

      const listedText = await (await fetch(`${base}/api/cameras`)).text();
      const listed = JSON.parse(listedText);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].status, 'configured');
      assert.equal(listed[0].lastTestSummary, 'passed');
      assert.equal(listed[0].manufacturer, 'Acme');
      assert.equal(Object.hasOwn(listed[0], 'firmware'), false);
      assert.equal(listedText.includes('fw-build-9'), false);
      assertForbiddenKeys(listed[0]);
      assertNoSecrets(listedText);

      const oneText = await (await fetch(`${base}/api/cameras/${cameraId}`)).text();
      const one = JSON.parse(oneText);
      assert.equal(one.lastTestSummary, 'passed');
      assert.match(one.lastTestAt, /^\d{4}-\d{2}-\d{2}T/);
      assertNoSecrets(oneText);

      const streamText = await (await fetch(`${base}/api/cameras/${cameraId}/stream`)).text();
      const stream = JSON.parse(streamText);
      assert.equal(stream.stream, null);
      assert.equal(stream.delivery, 'unavailable');
      assertNoSecrets(streamText);

      const alias = await fetch(`${base}/api/onvif/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cameraId, [secretKey]: bodySecret })
      });
      const aliasText = await alias.text();
      const aliasBody = JSON.parse(aliasText);
      assert.equal(alias.status, 200);
      assert.equal(aliasBody.summary, 'passed');
      assert.equal(aliasBody.cameraId, cameraId);
      assertNoSecrets(aliasText);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(bodySecret) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('a rejected stored login fails authentication without leaking the fault', async () => {
  const dbPath = tempDb();
  let seenUser = '';
  let seenSecret = '';
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath,
      authOptions: { client: async () => ({ ok: true }) },
      interrogateOptions: {
        client: async () => ({
          ok: true,
          manufacturer: `Acme ${sentinel}`,
          model: 'Cam-100',
          profiles: [{ id: 'Profile_1', label: 'Main' }]
        })
      },
      testOptions: {
        client: async (target) => {
          seenUser = target.username;
          seenSecret = target.password;
          return {
            ok: false,
            error: 'auth_failed',
            detail: `NotAuthorized ${sentinel}`,
            [userKey]: target.username,
            [secretKey]: target.password,
            uri: `rtsp://operator:${sentinel}@192.0.2.10/stream`
          };
        }
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const cameraId = await configureCamera(base);
      const response = await fetch(`${base}/api/cameras/${cameraId}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.summary, 'failed');
      const mapped = checkMap(body.checks);
      assert.equal(mapped.network.status, 'pass');
      assert.equal(mapped.authentication.status, 'fail');
      assert.equal(mapped.authentication.reason, 'auth_failed');
      assert.equal(mapped.onvif.status, 'pass');
      assert.equal(mapped.deviceInfo.status, 'pass');
      assert.equal(mapped.mainStream.status, 'skipped');
      assert.equal(mapped.mainStream.reason, 'not_implemented');
      assertForbiddenKeys(body);
      assertNoSecrets(text);
      const listed = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
      assert.equal(listed.status, 'configured');
      assert.equal(listed.lastTestSummary, 'failed');
      assert.equal(listed.manufacturer, 'Acme');
      assert.equal(seenUser, 'operator');
      assert.equal(seenSecret, sentinel);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('an unreachable camera fails the network check and ignores body secrets', async () => {
  let fetched = false;
  let seenSecret = '';
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath: tempDb(),
      authOptions: { client: async () => ({ ok: true }) },
      interrogateOptions: {
        client: async () => ({
          ok: true,
          manufacturer: 'Acme',
          model: 'Cam-100',
          profiles: [{ id: 'Profile_1', label: 'Main' }]
        })
      },
      testOptions: {
        client: async (target) => {
          seenSecret = target.password;
          throw new Error(`down ${target.password} ${target.username} ${sentinel}`);
        },
        fetchImpl: async () => {
          fetched = true;
          return { status: 200, async text() { return sentinel; } };
        }
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const cameraId = await configureCamera(base);
      const response = await fetch(`${base}/api/cameras/${cameraId}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [secretKey]: bodySecret, cameraId: `leak-${sentinel}` })
      });
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 200);
      assert.equal(body.summary, 'failed');
      const mapped = checkMap(body.checks);
      assert.equal(mapped.network.status, 'fail');
      assert.equal(mapped.network.reason, 'unreachable');
      assert.equal(mapped.authentication.status, 'fail');
      assert.equal(mapped.onvif.status, 'fail');
      assert.equal(mapped.deviceInfo.status, 'pass');
      assert.equal(mapped.audio.status, 'skipped');
      assertForbiddenKeys(body);
      assertNoSecrets(text);
      assert.equal(fetched, false);
      assert.equal(seenSecret, sentinel);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(bodySecret) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('missing device info fails that check and a live auth fault does not fetch a stream', async () => {
  const calls = [];
  const started = await startServer({
    port: 0,
    dbPath: tempDb(),
    authOptions: { client: async () => ({ ok: true }) },
    interrogateOptions: {
      client: async () => ({ ok: true, manufacturer: null, model: null, profiles: [] })
    },
    testOptions: {
      connectImpl: async () => true,
      timeoutMs: 400,
      fetchImpl: async (url, options) => {
        calls.push(String(options && options.body || ''));
        return { status: 401, async text() { return `NotAuthorized ${sentinel}`; } };
      }
    }
  });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const cameraId = await configureCamera(base, {});
    const response = await fetch(`${base}/api/cameras/${cameraId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.equal(body.summary, 'failed');
    const mapped = checkMap(body.checks);
    assert.equal(mapped.network.status, 'pass');
    assert.equal(mapped.authentication.status, 'fail');
    assert.equal(mapped.authentication.reason, 'auth_failed');
    assert.equal(mapped.onvif.status, 'pass');
    assert.equal(mapped.deviceInfo.status, 'fail');
    assert.equal(mapped.deviceInfo.reason, 'no_device_info');
    assert.equal(mapped.substream.reason, 'not_implemented');
    assertNoSecrets(text);
    assert.equal(calls.length, 1);
    assert.equal(/GetStreamUri|GetProfiles|rtsp:/i.test(calls[0]), false);
    assert.equal(calls[0].includes(sentinel), false);
  } finally {
    await closeServer(started);
  }
});

test('test refuses cameras that are not configured and keeps discover and stream contracts', async () => {
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath: tempDb(),
      authOptions: { client: async () => ({ ok: true }) },
      testOptions: {
        client: async () => {
          throw new Error('test client must not run');
        }
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const created = await (await fetch(`${base}/api/cameras`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Manual', [secretKey]: sentinel })
      })).json();
      const manual = await fetch(`${base}/api/cameras/${created.id}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [secretKey]: sentinel })
      });
      const manualText = await manual.text();
      assert.equal(manual.status, 409);
      assert.deepEqual(JSON.parse(manualText), {
        ok: false,
        contract: 'onvif.test.v0',
        implemented: true,
        error: 'not_authenticated'
      });
      assertNoSecrets(manualText);

      const authed = await (await fetch(`${base}/api/onvif/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authBody())
      })).json();
      const early = await fetch(`${base}/api/cameras/${authed.cameraId}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      const earlyText = await early.text();
      assert.equal(early.status, 409);
      assert.equal(JSON.parse(earlyText).error, 'not_configured');
      assertNoSecrets(earlyText);
      const still = await (await fetch(`${base}/api/cameras/${authed.cameraId}`)).json();
      assert.equal(still.status, 'authenticated');
      assert.deepEqual(Object.keys(still).sort(), PUBLIC_KEYS);

      const missing = await fetch(`${base}/api/cameras/missing/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [secretKey]: sentinel })
      });
      const missingText = await missing.text();
      assert.equal(missing.status, 404);
      assert.equal(JSON.parse(missingText).error, 'not_found');
      assertNoSecrets(missingText);

      const bare = await fetch(`${base}/api/onvif/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cameraId: sentinel })
      });
      const bareText = await bare.text();
      assert.equal(bare.status, 404);
      assert.equal(bareText.includes(sentinel), false);

      const streamText = await (await fetch(`${base}/api/cameras/${authed.cameraId}/stream`)).text();
      assert.equal(JSON.parse(streamText).delivery, 'unavailable');
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('signing in again clears the saved test summary', async () => {
  const started = await startServer({
    port: 0,
    dbPath: tempDb(),
    authOptions: { client: async () => ({ ok: true }) },
    interrogateOptions: {
      client: async () => ({
        ok: true,
        manufacturer: 'Acme',
        model: 'Cam-100',
        profiles: [{ id: 'Profile_1', label: 'Main' }]
      })
    },
    testOptions: { client: async () => ({ ok: true }) }
  });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const cameraId = await configureCamera(base);
    const tested = await (await fetch(`${base}/api/cameras/${cameraId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })).json();
    assert.equal(tested.summary, 'passed');
    const again = await fetch(`${base}/api/onvif/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(authBody())
    });
    assert.equal((await again.json()).cameraId, cameraId);
    const reset = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
    assert.equal(reset.status, 'authenticated');
    assert.deepEqual(Object.keys(reset).sort(), PUBLIC_KEYS);
    const blocked = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Gate', site: 'Main', group: 'Exterior' })
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, 'not_interrogated');
  } finally {
    await closeServer(started);
  }
});

test('the cameras page runs test without asking for the login again', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const cardStart = html.indexOf('id="test-camera"');
  const card = html.slice(cardStart);
  assert.equal(cardStart > 0, true);
  assert.match(html, /\/api\/cameras\/' \+ encodeURIComponent\(selectedTestId\) \+ '\/test/);
  assert.match(html, /Run test/);
  assert.match(html, /Test passed\. Stream checks were not run\./);
  assert.match(html, /Configure the camera before running Test\./);
  assert.match(html, /Stream, audio, PTZ, and event checks are not run/);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  assert.equal(/type="password"|name="password"|name="username"/i.test(card), false);
  assert.equal(html.includes('result.textContent = data'), false);
  assert.equal(html.includes('result.textContent = JSON.stringify'), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(html), false);
  assert.equal(/GetStreamUri|rtsp:|webrtc/i.test(html), false);
  assert.equal(html.includes(sentinel), false);
});
