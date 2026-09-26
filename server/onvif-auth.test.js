import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCameraStore } from './persistence.js';
import { startServer } from './index.js';
import {
  buildDeviceInformationEnvelope,
  callDeviceService,
  interpretDeviceService,
  parseAuthenticateRequest
} from './onvif-auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretKey = ['pass', 'word'].join('');
const userKey = ['user', 'name'].join('');
const sentinel = 'sentinel-secret-value';
const PUBLIC_KEYS = ['createdAt', 'group', 'id', 'name', 'site', 'status'];

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u2-'));
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
  assert.equal(serialized.includes('operator'), false);
  assert.equal(serialized.toLowerCase().includes(secretKey), false);
  assert.equal(serialized.toLowerCase().includes(userKey), false);
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

function authBody(extra = {}) {
  return {
    host: '192.0.2.10',
    port: 80,
    name: 'Front Door',
    [userKey]: 'operator',
    [secretKey]: sentinel,
    ...extra
  };
}

test('the device-service envelope digests the password and does not contain it', () => {
  const nonce = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const created = '2020-01-01T00:00:00.000Z';
  const expected = createHash('sha1').update(Buffer.concat([
    nonce,
    Buffer.from(created, 'utf8'),
    Buffer.from(sentinel, 'utf8')
  ])).digest('base64');
  const xml = buildDeviceInformationEnvelope('a<b&c', sentinel, { nonce, created });
  assert.equal(xml.includes(expected), true);
  assert.equal(xml.includes('<wsse:Username>a&lt;b&amp;c</wsse:Username>'), true);
  assert.equal(xml.includes('a<b'), false);
  assert.equal(xml.includes(sentinel), false);
  assert.equal(xml.includes('GetDeviceInformation'), true);
  assert.equal(/rtsp|GetStreamUri|MediaMTX|go2rtc|webrtc/i.test(xml), false);
});

test('a device-service fault or echo is not copied into the auth result', async () => {
  const rejected = interpretDeviceService(401, `NotAuthorized ${sentinel} operator`);
  assert.deepEqual(rejected, { ok: false, error: 'auth_failed' });
  assertNoSecrets(JSON.stringify(rejected));

  const fault = interpretDeviceService(200, `<s:Fault><s:Value>ter:NotAuthorized</s:Value><s:Text>${sentinel}</s:Text></s:Fault>`);
  assert.equal(fault.ok, false);
  assert.equal(fault.error, 'auth_failed');
  assertNoSecrets(JSON.stringify(fault));

  const ok = interpretDeviceService(200, '<tds:GetDeviceInformationResponse><tds:Manufacturer>Acme</tds:Manufacturer></tds:GetDeviceInformationResponse>');
  assert.deepEqual(ok, { ok: true });

  const thrown = await callDeviceService(authBody(), {
    timeoutMs: 200,
    fetchImpl: async () => {
      throw new Error(sentinel);
    }
  });
  assert.deepEqual(thrown, { ok: false, error: 'unreachable' });
  assertNoSecrets(JSON.stringify(thrown));
});

test('the device-service client posts GetDeviceInformation without the raw password', async () => {
  let captured = null;
  const result = await callDeviceService({
    scheme: 'http',
    host: '192.0.2.10',
    port: 8080,
    path: '/onvif/device_service',
    [userKey]: 'operator',
    [secretKey]: sentinel
  }, {
    timeoutMs: 200,
    fetchImpl: async (url, options) => {
      captured = { url, method: options.method, body: options.body };
      return {
        status: 200,
        async text() {
          return `<tds:GetDeviceInformationResponse>${sentinel}</tds:GetDeviceInformationResponse>`;
        }
      };
    }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, 'http://192.0.2.10:8080/onvif/device_service');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body.includes('GetDeviceInformation'), true);
  assert.equal(captured.body.includes(sentinel), false);
  assert.equal(/rtsp|GetStreamUri/i.test(captured.body), false);
});

test('a non-routable device service is unreachable and returns no secrets', async () => {
  const result = await callDeviceService({
    scheme: 'http',
    host: '192.0.2.1',
    port: 80,
    path: '/onvif/device_service',
    [userKey]: 'operator',
    [secretKey]: sentinel
  }, { timeoutMs: 300 });
  assert.deepEqual(result, { ok: false, error: 'unreachable' });
  assertNoSecrets(JSON.stringify(result));
});

test('failed auth does not store or return secrets', async () => {
  const dbPath = tempDb();
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath,
      authOptions: {
        client: async () => {
          throw new Error(`rejected ${sentinel} operator`);
        }
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const response = await fetch(`${base}/api/onvif/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...authBody(),
          authenticated: true,
          rtspUrl: `rtsp://operator:${sentinel}@192.0.2.10/stream`
        })
      });
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 502);
      assert.equal(body.ok, false);
      assert.equal(body.authenticated, false);
      assert.equal(body.error, 'unreachable');
      assert.equal(body.contract, 'onvif.authenticate.v0');
      assertForbiddenKeys(body);
      assertNoSecrets(text);
      assert.equal(text.includes('rtsp://'), false);

      const listed = await fetch(`${base}/api/cameras`);
      const listedText = await listed.text();
      assert.equal(listedText, '[]');
      assertNoSecrets(listedText);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('operator')), false);

      const raw = fs.readFileSync(dbPath);
      assert.equal(raw.includes(Buffer.from(sentinel)), false);
      assert.equal(raw.includes(Buffer.from('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('a rejected device login is observable and stores nothing', async () => {
  const dbPath = tempDb();
  await withLogs(async (logs) => {
    const started = await startServer({
      port: 0,
      dbPath,
      authOptions: {
        client: async (target) => ({
          ok: false,
          error: 'auth_failed',
          [userKey]: target.username,
          [secretKey]: target.password
        })
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const response = await fetch(`${base}/api/onvif/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authBody())
      });
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 401);
      assert.deepEqual(body, {
        ok: false,
        contract: 'onvif.authenticate.v0',
        authenticated: false,
        error: 'auth_failed'
      });
      assertForbiddenKeys(body);
      assertNoSecrets(text);
      assert.equal(await (await fetch(`${base}/api/cameras`)).text(), '[]');
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('operator')), false);
      const raw = fs.readFileSync(dbPath);
      assert.equal(raw.includes(Buffer.from(sentinel)), false);
      assert.equal(raw.includes(Buffer.from('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('successful auth marks the camera and keeps secrets on the server', async () => {
  const dbPath = tempDb();
  await withLogs(async (logs) => {
    let soap = '';
    const started = await startServer({
      port: 0,
      dbPath,
      authOptions: {
        fetchImpl: async (_url, options) => {
          soap = String(options.body || '');
          return {
            status: 200,
            async text() {
              return `<tds:GetDeviceInformationResponse><tds:Model>${sentinel}</tds:Model></tds:GetDeviceInformationResponse>`;
            }
          };
        }
      }
    });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const response = await fetch(`${base}/api/onvif/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authBody({ path: '/onvif/device_service', scheme: 'http' }))
      });
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.authenticated, true);
      assert.equal(body.contract, 'onvif.authenticate.v0');
      assert.equal(typeof body.cameraId, 'string');
      assert.deepEqual(Object.keys(body).sort(), ['authenticated', 'cameraId', 'contract', 'ok']);
      assertForbiddenKeys(body);
      assertNoSecrets(text);

      const listedRes = await fetch(`${base}/api/cameras`);
      const listedText = await listedRes.text();
      const listed = JSON.parse(listedText);
      assert.equal(listed.length, 1);
      assert.deepEqual(Object.keys(listed[0]).sort(), PUBLIC_KEYS);
      assert.equal(listed[0].status, 'authenticated');
      assert.equal(listed[0].name, 'Front Door');
      assert.equal(listed[0].id, body.cameraId);
      assertNoSecrets(listedText);

      const oneRes = await fetch(`${base}/api/cameras/${body.cameraId}`);
      const oneText = await oneRes.text();
      const one = JSON.parse(oneText);
      assert.deepEqual(Object.keys(one).sort(), PUBLIC_KEYS);
      assert.equal(one.status, 'authenticated');
      assertNoSecrets(oneText);

      const streamRes = await fetch(`${base}/api/cameras/${body.cameraId}/stream`);
      const streamText = await streamRes.text();
      const stream = JSON.parse(streamText);
      assert.equal(stream.stream, null);
      assert.equal(stream.delivery, 'unavailable');
      assert.equal(streamText.includes('rtsp://'), false);
      assertNoSecrets(streamText);

      const again = await fetch(`${base}/api/onvif/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(authBody())
      });
      const againBody = await again.json();
      assert.equal(againBody.cameraId, body.cameraId);
      const after = await (await fetch(`${base}/api/cameras`)).json();
      assert.equal(after.length, 1);
      assert.equal(after[0].status, 'authenticated');

      const probe = await fetch(`${base}/api/onvif/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal((await probe.json()).implemented, false);

      assert.equal(soap.includes('GetDeviceInformation'), true);
      assert.equal(soap.includes(sentinel), false);
      assert.equal(/rtsp|GetStreamUri/i.test(soap), false);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('operator')), false);
      const raw = fs.readFileSync(dbPath);
      assert.equal(raw.includes(Buffer.from(sentinel)), true);
      assert.equal(raw.includes(Buffer.from('rtsp://')), false);
    } finally {
      await closeServer(started);
    }
  });

  const reopened = createCameraStore(dbPath);
  try {
    const listed = await reopened.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'authenticated');
    assert.deepEqual(Object.keys(listed[0]).sort(), PUBLIC_KEYS);
    assertNoSecrets(JSON.stringify(listed));
  } finally {
    reopened.close();
  }
});

test('invalid authenticate input does not echo secrets', async () => {
  await withLogs(async (logs) => {
    const started = await startServer({ port: 0, dbPath: tempDb() });
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const response = await fetch(`${base}/api/onvif/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: `operator:${sentinel}@192.0.2.10`,
          port: 80,
          [userKey]: 'operator',
          [secretKey]: sentinel
        })
      });
      const text = await response.text();
      assert.equal(response.status, 400);
      assert.equal(JSON.parse(text).error, 'invalid_request');
      assertNoSecrets(text);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('operator')), false);
      assert.throws(
        () => parseAuthenticateRequest({ host: '192.0.2.10', port: 80, [userKey]: 'operator', [secretKey]: '' }),
        (err) => err.code === 'VALIDATION'
      );
    } finally {
      await closeServer(started);
    }
  });
});

test('the cameras page posts the password to the server and does not keep it', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /id="auth-password"/);
  assert.match(html, /type="password"/);
  assert.match(html, /\/api\/onvif\/authenticate/);
  assert.match(html, /passwordEl\.value = ''/);
  assert.match(html, /Authenticated\. The login stays on the server\./);
  assert.match(html, /Authentication failed\. The login was not stored\./);
  assert.equal(html.includes('result.textContent = data'), false);
  assert.equal(html.includes('result.textContent = JSON.stringify'), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(html), false);
  assert.equal(html.includes(sentinel), false);
});
