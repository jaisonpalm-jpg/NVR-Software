import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOnvifEnvelope } from './onvif-interrogate.js';
import { startServer } from './index.js';
import {
  buildGetStreamUriBody,
  callMediaStream,
  composePullUrl,
  normalizeSourceUrl,
  publicStreamError,
  publicStreamPayload,
  streamContract
} from './onvif-stream.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretKey = ['pass', 'word'].join('');
const userKey = ['user', 'name'].join('');
const sentinel = 'sentinel-secret-value';
const marker = 'channel-unique-path';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u6-'));
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
  assert.equal(serialized.includes(marker), false);
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

function serverOptions(dbPath, streamClient, extra = {}) {
  return {
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
      client: async () => ({ ok: true }),
      connectImpl: async () => {}
    },
    streamOptions: {
      client: streamClient,
      frameSource: extra.frameSource,
      ffmpegPath: extra.ffmpegPath
    }
  };
}

async function onboard(base, { profile = true } = {}) {
  const authed = await fetch(`${base}/api/onvif/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(authBody())
  });
  const cameraId = (await authed.json()).cameraId;
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
      ...(profile ? { profileId: 'Profile_1' } : {})
    })
  });
  assert.equal(saved.status, 200);
  const tested = await fetch(`${base}/api/cameras/${cameraId}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal((await tested.json()).summary, 'passed');
  const reviewed = await fetch(`${base}/api/cameras/${cameraId}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true })
  });
  assert.equal(reviewed.status, 200);
  const ready = await fetch(`${base}/api/cameras/${cameraId}/success`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true })
  });
  assert.equal((await ready.json()).camera.status, 'ready');
  return cameraId;
}

test('stream uri envelopes digest the password and name the profile', () => {
  const nonce = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const created = '2020-01-01T00:00:00.000Z';
  const expected = createHash('sha1').update(Buffer.concat([
    nonce,
    Buffer.from(created, 'utf8'),
    Buffer.from(sentinel, 'utf8')
  ])).digest('base64');
  const xml = buildOnvifEnvelope('operator', sentinel, buildGetStreamUriBody('Profile_<1>'), { nonce, created });
  assert.equal(xml.includes(expected), true);
  assert.equal(xml.includes(sentinel), false);
  assert.equal(xml.includes('GetStreamUri'), true);
  assert.equal(xml.includes('Profile_&lt;1&gt;'), true);
  assert.equal(xml.includes('RTP-Unicast'), true);
  assert.equal(streamContract(), 'onvif.stream.v0');
});

test('a media uri is kept for the matching host only and public json drops it', () => {
  const source = normalizeSourceUrl(`rtsp://operator:${sentinel}@192.0.2.10/${marker}`, '192.0.2.10');
  assert.equal(source.hostname, '192.0.2.10');
  assert.equal(source.pathname, `/${marker}`);
  assert.equal(source.username, 'operator');
  assert.equal(normalizeSourceUrl('http://192.0.2.99/live', '192.0.2.10'), null);
  assert.equal(normalizeSourceUrl('file:///tmp/x', '192.0.2.10'), null);
  assert.equal(normalizeSourceUrl('javascript:alert(1)', '192.0.2.10'), null);
  const payload = publicStreamPayload('cam-1', 'Profile_1');
  const text = JSON.stringify(payload);
  assert.equal(payload.stream, '/api/cameras/cam-1/live');
  assert.equal(payload.delivery, 'mjpeg');
  assertNoSecrets(text);
  const hidden = publicStreamError(`rtsp://operator:${sentinel}@192.0.2.10/${marker}`);
  assert.equal(hidden.status, 502);
  assert.equal(hidden.body.error, 'unreachable');
  assertNoSecrets(JSON.stringify(hidden));
  const pull = composePullUrl(source, 'other', 'nope');
  assert.equal(pull.includes(sentinel), true);
  assert.equal(text.includes(pull), false);
});

test('the device client requests a stream uri without putting the password in the body', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: String(options && options.body || '') });
    const body = calls[calls.length - 1].body;
    if (body.includes('GetCapabilities')) {
      return {
        status: 200,
        async text() {
          return '<tds:GetCapabilitiesResponse><tt:Media><tt:XAddr>http://operator:hidden@192.0.2.10/onvif/media_service</tt:XAddr></tt:Media></tds:GetCapabilitiesResponse>';
        }
      };
    }
    if (body.includes('GetStreamUri')) {
      return {
        status: 200,
        async text() {
          return `<trt:GetStreamUriResponse><tt:Uri>rtsp://operator:${sentinel}@192.0.2.10/${marker}</tt:Uri></trt:GetStreamUriResponse>`;
        }
      };
    }
    return { status: 500, async text() { return sentinel; } };
  };
  const result = await callMediaStream({
    host: '192.0.2.10',
    port: 80,
    path: '/onvif/device_service',
    scheme: 'http',
    [userKey]: 'operator',
    [secretKey]: sentinel,
    profileId: 'Profile_1'
  }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.sourceUrl.includes(marker), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://192.0.2.10:80/onvif/device_service');
  assert.equal(calls[1].url, 'http://192.0.2.10/onvif/media_service');
  assert.equal(calls[1].body.includes('GetStreamUri'), true);
  assert.equal(calls[1].body.includes('Profile_1'), true);
  assert.equal(calls[1].body.includes(sentinel), false);
  assert.equal(calls[0].body.includes(sentinel), false);
});

test('a ready camera exposes a proxy path and frames without secrets', async () => {
  const calls = [];
  let frameInfo = null;
  await withLogs(async (logs) => {
    const dbPath = tempDb();
    const started = await startServer(serverOptions(dbPath, async (target) => {
      calls.push({ host: target.host, profileId: target.profileId, sawSecret: target.password === sentinel });
      return { ok: true, sourceUrl: `rtsp://operator:${sentinel}@192.0.2.10/${marker}` };
    }, {
      frameSource: async function* (info) {
        frameInfo = info;
        yield jpeg;
      }
    }));
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const blocked = await fetch(`${base}/api/cameras/missing/stream`);
      const blockedText = await blocked.text();
      assert.equal(blocked.status, 404);
      assert.equal(JSON.parse(blockedText).error, 'not_found');
      assertNoSecrets(blockedText);

      const cameraId = await onboard(base);
      assert.equal(calls.length, 0);
      const streamRes = await fetch(`${base}/api/cameras/${cameraId}/stream`);
      const streamText = await streamRes.text();
      const stream = JSON.parse(streamText);
      assert.equal(streamRes.status, 200);
      assert.equal(stream.ok, true);
      assert.equal(stream.contract, 'onvif.stream.v0');
      assert.equal(stream.delivery, 'mjpeg');
      assert.equal(stream.profileId, 'Profile_1');
      assert.equal(stream.stream, `/api/cameras/${cameraId}/live`);
      assert.deepEqual(Object.keys(stream).sort(), ['cameraId', 'contract', 'delivery', 'ok', 'profileId', 'stream']);
      assertForbiddenKeys(stream);
      assertNoSecrets(streamText);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].sawSecret, true);
      assert.equal(calls[0].profileId, 'Profile_1');

      const listedText = await (await fetch(`${base}/api/cameras`)).text();
      const listed = JSON.parse(listedText);
      assert.equal(listed[0].status, 'ready');
      assert.equal(Object.hasOwn(listed[0], 'stream'), false);
      assertNoSecrets(listedText);

      const liveRes = await fetch(`${base}/api/cameras/${cameraId}/live`);
      const liveType = liveRes.headers.get('content-type') || '';
      const liveBytes = Buffer.from(await liveRes.arrayBuffer());
      assert.equal(liveRes.status, 200);
      assert.match(liveType, /multipart\/x-mixed-replace/);
      assert.equal(liveRes.headers.get('cache-control'), 'no-store');
      assert.equal(liveBytes.includes(jpeg), true);
      assertNoSecrets(liveBytes.toString('utf8'));
      assert.equal(frameInfo.cameraId, cameraId);
      assert.equal(frameInfo.profileId, 'Profile_1');
      assert.equal(Object.hasOwn(frameInfo, 'sourceUrl'), false);
      assert.equal(Object.hasOwn(frameInfo, secretKey), false);
      assert.equal(calls.length, 2);

      const raw = fs.readFileSync(dbPath);
      assert.equal(raw.includes(Buffer.from(marker)), false);
      assert.equal(raw.includes(Buffer.from(`rtsp://operator:${sentinel}`)), false);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(marker) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('non-ready cameras and a foreign media host are refused without a proxy body', async () => {
  let pulls = 0;
  const started = await startServer(serverOptions(tempDb(), async () => ({
    ok: true,
    sourceUrl: `http://192.0.2.99/${marker}`
  }), {
    frameSource: async function* () {
      pulls += 1;
      yield jpeg;
    }
  }));
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const created = await (await fetch(`${base}/api/cameras`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Manual', [secretKey]: sentinel })
    })).json();
    const manual = await fetch(`${base}/api/cameras/${created.id}/stream`);
    const manualText = await manual.text();
    assert.equal(manual.status, 409);
    assert.equal(JSON.parse(manualText).error, 'not_authenticated');
    assertNoSecrets(manualText);
    const manualLive = await fetch(`${base}/api/cameras/${created.id}/live`);
    assert.equal(manualLive.status, 409);
    assert.equal((await manualLive.json()).error, 'not_authenticated');

    const cameraId = await onboard(base, { profile: false });
    const missing = await fetch(`${base}/api/cameras/${cameraId}/stream`);
    const missingText = await missing.text();
    assert.equal(missing.status, 409);
    assert.equal(JSON.parse(missingText).error, 'missing_profile');
    assertNoSecrets(missingText);
    assert.equal(pulls, 0);

    const authed = await fetch(`${base}/api/onvif/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(authBody())
    });
    const otherId = (await authed.json()).cameraId;
    await fetch(`${base}/api/cameras/${otherId}/interrogate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    await fetch(`${base}/api/cameras/${otherId}/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Gate', site: 'Main', group: 'Exterior', profileId: 'Profile_1' })
    });
    const configured = await fetch(`${base}/api/cameras/${otherId}/stream`);
    assert.equal(configured.status, 409);
    assert.equal((await configured.json()).error, 'not_ready');

    const readyId = await onboard(base);
    const foreign = await fetch(`${base}/api/cameras/${readyId}/stream`);
    const foreignText = await foreign.text();
    assert.equal(foreign.status, 502);
    assert.equal(JSON.parse(foreignText).error, 'unreachable');
    assertNoSecrets(foreignText);
    const foreignLive = await fetch(`${base}/api/cameras/${readyId}/live`);
    const foreignLiveText = await foreignLive.text();
    assert.equal(foreignLive.status, 502);
    assert.equal(JSON.parse(foreignLiveText).error, 'unreachable');
    assertNoSecrets(foreignLiveText);
    assert.equal(pulls, 0);
  } finally {
    await closeServer(started);
  }
});

test('a rejected login is not a stream and a puller cannot echo the media uri', async () => {
  await withLogs(async (logs) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u6-pull-'));
    const argvOut = path.join(dir, 'argv.txt');
    const stub = path.join(dir, 'ffmpeg-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvOut}'\n`);
    fs.chmodSync(stub, 0o755);
    const started = await startServer(serverOptions(tempDb(), async (target) => {
      if (target.password !== sentinel) return { ok: false, error: 'auth_failed' };
      return { ok: true, sourceUrl: `rtsp://operator:${sentinel}@192.0.2.10/${marker}` };
    }, { ffmpegPath: stub }));
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const cameraId = await onboard(base);
      const denied = await startServer({
        port: 0,
        dbPath: tempDb(),
        authOptions: { client: async () => ({ ok: true }) },
        interrogateOptions: {
          client: async () => ({
            ok: true,
            manufacturer: 'Acme',
            model: 'Cam-100',
            profiles: [{ token: 'Profile_1', name: 'Main' }]
          })
        },
        testOptions: { client: async () => ({ ok: true }) },
        streamOptions: {
          client: async () => ({ ok: false, error: 'auth_failed', detail: sentinel })
        }
      });
      const deniedBase = `http://127.0.0.1:${denied.port}`;
      const deniedId = await onboard(deniedBase);
      const authRes = await fetch(`${deniedBase}/api/cameras/${deniedId}/stream`);
      const authText = await authRes.text();
      assert.equal(authRes.status, 401);
      assert.equal(JSON.parse(authText).error, 'auth_failed');
      assertNoSecrets(authText);
      await closeServer(denied);

      const liveRes = await fetch(`${base}/api/cameras/${cameraId}/live`);
      const liveText = await liveRes.text();
      assert.equal(liveRes.status, 502);
      assert.equal(JSON.parse(liveText).error, 'stream_unavailable');
      assertNoSecrets(liveText);
      const argv = fs.readFileSync(argvOut, 'utf8');
      assert.equal(argv.includes(sentinel), true);
      assert.equal(argv.includes(marker), true);
      assert.equal(liveText.includes(sentinel), false);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(marker)), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('non-jpeg puller output is not forwarded', async () => {
  const started = await startServer(serverOptions(tempDb(), async () => ({
    ok: true,
    sourceUrl: `rtsp://192.0.2.10/${marker}`
  }), {
    frameSource: async function* () {
      yield Buffer.from(sentinel);
    }
  }));
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const cameraId = await onboard(base);
    const liveRes = await fetch(`${base}/api/cameras/${cameraId}/live`);
    const liveText = await liveRes.text();
    assert.equal(liveRes.status, 502);
    assert.equal(JSON.parse(liveText).error, 'stream_unavailable');
    assertNoSecrets(liveText);
  } finally {
    await closeServer(started);
  }
});

test('the live page asks for the proxy path and does not paint recording chrome', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const liveStart = html.indexOf('id="live"');
  const liveEnd = html.indexOf('id="playback"');
  const liveHtml = html.slice(liveStart, liveEnd);
  assert.equal(liveStart > 0 && liveEnd > liveStart, true);
  assert.match(html, /\/api\/cameras\/' \+ encodeURIComponent\(camera\.id\) \+ '\/stream/);
  assert.match(html, /function livePathFor\(id\)/);
  assert.match(html, /Connecting/);
  assert.match(html, /LIVE/);
  assert.match(html, /#2f6bff/);
  assert.match(html, /\.feed \{[^}]*border-radius: 10px;/);
  assert.equal(/REC|FPS|Recording|H\.264|H\.265/.test(liveHtml), false);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  assert.equal(html.includes('<video'), false);
  assert.equal(html.includes('result.textContent = data'), false);
  assert.equal(html.includes('result.textContent = JSON.stringify'), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(html), false);
  assert.equal(/GetStreamUri|rtsp:|webrtc|MediaMTX|go2rtc/i.test(html), false);
  assert.equal(html.includes(sentinel), false);
  assert.match(html, /id="playback"/);
  assert.match(html, /id="storage"/);
  assert.match(html, /id="settings"/);
  assert.match(html, /Recording playback is not available in this unit/);
});
