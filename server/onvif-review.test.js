import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretKey = ['pass', 'word'].join('');
const userKey = ['user', 'name'].join('');
const sentinel = 'sentinel-secret-value';
const bodySecret = 'body-secret-not-stored';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u5-'));
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
  assert.equal(serialized.includes('fw-build-9'), false);
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

function serverOptions(dbPath, probe, calls) {
  return {
    port: 0,
    dbPath,
    authOptions: {
      client: async () => {
        calls.device += 1;
        return { ok: true };
      }
    },
    interrogateOptions: {
      client: async () => {
        calls.device += 1;
        return {
          ok: true,
          manufacturer: 'Acme',
          model: 'Cam-100',
          firmware: 'fw-build-9',
          profiles: [{ token: 'Profile_1', name: 'Main' }],
          [secretKey]: sentinel
        };
      }
    },
    testOptions: {
      client: async () => {
        calls.device += 1;
        return probe;
      },
      fetchImpl: async () => {
        calls.device += 1;
        return { status: 200, async text() { return sentinel; } };
      }
    }
  };
}

async function configureCamera(base) {
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
      profileId: 'Profile_1'
    })
  });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(savedBody.camera.status, 'configured');
  return cameraId;
}

function postStep(base, id, step, body) {
  return fetch(`${base}/api/cameras/${id}/${step}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('review then success marks a passed camera ready and keeps secrets on the server', async () => {
  const calls = { device: 0 };
  await withLogs(async (logs) => {
    const started = await startServer(serverOptions(tempDb(), { ok: true }, calls));
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const cameraId = await configureCamera(base);
      const tested = await fetch(`${base}/api/cameras/${cameraId}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal((await tested.json()).summary, 'passed');
      const deviceCallsAfterTest = calls.device;

      const review = await postStep(base, cameraId, 'review', {
        confirm: true,
        [userKey]: 'body-user-not-stored',
        [secretKey]: bodySecret,
        rtspUrl: `rtsp://operator:${sentinel}@192.0.2.10/stream`
      });
      const reviewText = await review.text();
      const reviewBody = JSON.parse(reviewText);
      assert.equal(review.status, 200);
      assert.equal(reviewBody.ok, true);
      assert.equal(reviewBody.contract, 'onvif.review.v0');
      assert.equal(reviewBody.camera.status, 'configured');
      assert.equal(reviewBody.camera.lastTestSummary, 'passed');
      assert.equal(reviewBody.camera.name, 'Gate');
      assert.equal(reviewBody.camera.site, 'Main');
      assert.equal(reviewBody.camera.group, 'Exterior');
      assert.equal(reviewBody.camera.manufacturer, 'Acme');
      assert.equal(reviewBody.camera.model, 'Cam-100');
      assert.equal(reviewBody.camera.profileLabel, 'Main');
      assert.match(reviewBody.camera.reviewedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
      assert.equal(Object.hasOwn(reviewBody.camera, 'firmware'), false);
      assertForbiddenKeys(reviewBody);
      assertNoSecrets(reviewText);

      const again = await postStep(base, cameraId, 'review', { confirm: true });
      const againBody = await again.json();
      assert.equal(again.status, 200);
      assert.equal(againBody.camera.reviewedAt, reviewBody.camera.reviewedAt);
      assert.equal(againBody.camera.status, 'configured');

      const earlySuccessCalls = calls.device;
      const success = await postStep(base, cameraId, 'success', {
        confirm: true,
        [userKey]: 'body-user-not-stored',
        [secretKey]: bodySecret
      });
      const successText = await success.text();
      const successBody = JSON.parse(successText);
      assert.equal(success.status, 200);
      assert.equal(successBody.ok, true);
      assert.equal(successBody.contract, 'onvif.success.v0');
      assert.equal(successBody.camera.status, 'ready');
      assert.equal(successBody.camera.reviewedAt, reviewBody.camera.reviewedAt);
      assert.deepEqual(Object.keys(successBody.camera).sort(), READY_KEYS.sort());
      assertForbiddenKeys(successBody);
      assertNoSecrets(successText);
      assert.equal(calls.device, deviceCallsAfterTest);
      assert.equal(calls.device, earlySuccessCalls);

      const repeat = await postStep(base, cameraId, 'success', { confirm: true });
      const repeatBody = await repeat.json();
      assert.equal(repeat.status, 200);
      assert.equal(repeatBody.camera.status, 'ready');
      assert.equal(repeatBody.camera.reviewedAt, reviewBody.camera.reviewedAt);

      const listedText = await (await fetch(`${base}/api/cameras`)).text();
      const listed = JSON.parse(listedText);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].status, 'ready');
      assert.equal(listed[0].lastTestSummary, 'passed');
      assert.equal(listed[0].reviewedAt, reviewBody.camera.reviewedAt);
      assert.deepEqual(Object.keys(listed[0]).sort(), READY_KEYS.sort());
      assertForbiddenKeys(listed[0]);
      assertNoSecrets(listedText);

      const oneText = await (await fetch(`${base}/api/cameras/${cameraId}`)).text();
      const one = JSON.parse(oneText);
      assert.equal(one.status, 'ready');
      assertNoSecrets(oneText);

      const streamText = await (await fetch(`${base}/api/cameras/${cameraId}/stream`)).text();
      const stream = JSON.parse(streamText);
      assert.equal(stream.stream, null);
      assert.equal(stream.delivery, 'unavailable');
      assertNoSecrets(streamText);
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(bodySecret) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('review and success refuse cameras that were not tested or whose last test failed', async () => {
  await withLogs(async (logs) => {
    const calls = { device: 0 };
    const started = await startServer(serverOptions(tempDb(), {
      ok: false,
      error: 'auth_failed',
      detail: `NotAuthorized ${sentinel}`
    }, calls));
    const base = `http://127.0.0.1:${started.port}`;
    try {
      const created = await (await fetch(`${base}/api/cameras`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Manual', [secretKey]: sentinel })
      })).json();
      for (const step of ['review', 'success']) {
        const manual = await postStep(base, created.id, step, { confirm: true, [secretKey]: sentinel });
        const manualText = await manual.text();
        assert.equal(manual.status, 409);
        assert.equal(JSON.parse(manualText).error, 'not_tested');
        assertNoSecrets(manualText);
      }
      const manualRow = await (await fetch(`${base}/api/cameras/${created.id}`)).json();
      assert.equal(manualRow.status, 'unknown');
      assert.equal(Object.hasOwn(manualRow, 'reviewedAt'), false);

      const cameraId = await configureCamera(base);
      const before = await postStep(base, cameraId, 'review', { confirm: true });
      const beforeText = await before.text();
      assert.equal(before.status, 409);
      assert.deepEqual(JSON.parse(beforeText), {
        ok: false,
        contract: 'onvif.review.v0',
        error: 'not_tested'
      });
      assertNoSecrets(beforeText);
      const blocked = await postStep(base, cameraId, 'success', { confirm: true });
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).error, 'not_tested');
      const still = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
      assert.equal(still.status, 'configured');
      assert.equal(Object.hasOwn(still, 'reviewedAt'), false);
      assert.equal(Object.hasOwn(still, 'lastTestSummary'), false);

      const tested = await fetch(`${base}/api/cameras/${cameraId}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal((await tested.json()).summary, 'failed');
      for (const step of ['review', 'success']) {
        const failed = await postStep(base, cameraId, step, { confirm: true, [secretKey]: bodySecret });
        const failedText = await failed.text();
        assert.equal(failed.status, 409);
        assert.equal(JSON.parse(failedText).error, 'test_failed');
        assert.equal(JSON.parse(failedText).contract, step === 'review' ? 'onvif.review.v0' : 'onvif.success.v0');
        assertNoSecrets(failedText);
      }
      const failedRow = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
      assert.equal(failedRow.status, 'configured');
      assert.equal(failedRow.lastTestSummary, 'failed');
      assert.equal(Object.hasOwn(failedRow, 'reviewedAt'), false);

      const missing = await postStep(base, 'missing', 'review', { confirm: true, [secretKey]: sentinel });
      const missingText = await missing.text();
      assert.equal(missing.status, 404);
      assert.equal(JSON.parse(missingText).error, 'not_found');
      assertNoSecrets(missingText);

      const streamText = await (await fetch(`${base}/api/cameras/${cameraId}/stream`)).text();
      assert.equal(JSON.parse(streamText).delivery, 'unavailable');
      assert.equal(logs.some((line) => line.includes(sentinel) || line.includes(bodySecret) || line.includes('operator')), false);
    } finally {
      await closeServer(started);
    }
  });
});

test('success requires review, a new test or configure clears it, and sign-in clears ready', async () => {
  const calls = { device: 0 };
  const started = await startServer(serverOptions(tempDb(), { ok: true }, calls));
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const cameraId = await configureCamera(base);
    const tested = await fetch(`${base}/api/cameras/${cameraId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal((await tested.json()).summary, 'passed');

    const skipped = await postStep(base, cameraId, 'success', { confirm: true });
    const skippedText = await skipped.text();
    assert.equal(skipped.status, 409);
    assert.deepEqual(JSON.parse(skippedText), {
      ok: false,
      contract: 'onvif.success.v0',
      error: 'not_reviewed'
    });
    assertNoSecrets(skippedText);
    const pending = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
    assert.equal(pending.status, 'configured');
    assert.equal(Object.hasOwn(pending, 'reviewedAt'), false);

    const empty = await postStep(base, cameraId, 'review', {});
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'invalid_request');
    const denied = await postStep(base, cameraId, 'success', { confirm: 'true' });
    assert.equal(denied.status, 400);
    assert.equal((await (await fetch(`${base}/api/cameras/${cameraId}`)).json()).status, 'configured');

    const reviewed = await (await postStep(base, cameraId, 'review', { confirm: true })).json();
    assert.match(reviewed.camera.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);

    const retest = await fetch(`${base}/api/cameras/${cameraId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal((await retest.json()).summary, 'passed');
    const cleared = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
    assert.equal(cleared.status, 'configured');
    assert.equal(cleared.lastTestSummary, 'passed');
    assert.equal(Object.hasOwn(cleared, 'reviewedAt'), false);
    const afterRetest = await postStep(base, cameraId, 'success', { confirm: true });
    assert.equal(afterRetest.status, 409);
    assert.equal((await afterRetest.json()).error, 'not_reviewed');

    await postStep(base, cameraId, 'review', { confirm: true });
    const reconfigured = await fetch(`${base}/api/cameras/${cameraId}/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Gate', site: 'Main', group: 'Yard', profileId: 'Profile_1' })
    });
    const reconfiguredBody = await reconfigured.json();
    assert.equal(reconfigured.status, 200);
    assert.equal(reconfiguredBody.camera.status, 'configured');
    assert.equal(reconfiguredBody.camera.group, 'Yard');
    assert.equal(reconfiguredBody.camera.lastTestSummary, 'passed');
    assert.equal(Object.hasOwn(reconfiguredBody.camera, 'reviewedAt'), false);
    const afterConfigure = await postStep(base, cameraId, 'success', { confirm: true });
    assert.equal(afterConfigure.status, 409);
    assert.equal((await afterConfigure.json()).error, 'not_reviewed');

    await postStep(base, cameraId, 'review', { confirm: true });
    const finished = await postStep(base, cameraId, 'success', { confirm: true });
    assert.equal((await finished.json()).camera.status, 'ready');
    const blockedTest = await fetch(`${base}/api/cameras/${cameraId}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(blockedTest.status, 409);
    assert.equal((await blockedTest.json()).error, 'not_configured');
    const stillReady = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
    assert.equal(stillReady.status, 'ready');

    const again = await fetch(`${base}/api/onvif/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(authBody())
    });
    assert.equal((await again.json()).cameraId, cameraId);
    const reset = await (await fetch(`${base}/api/cameras/${cameraId}`)).json();
    assert.equal(reset.status, 'authenticated');
    assert.deepEqual(Object.keys(reset).sort(), PUBLIC_KEYS);
    const stream = await (await fetch(`${base}/api/cameras/${cameraId}/stream`)).json();
    assert.equal(stream.stream, null);
    assert.equal(stream.delivery, 'unavailable');
  } finally {
    await closeServer(started);
  }
});

test('the cameras page reviews a non-secret summary and marks success without video', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const reviewStart = html.indexOf('id="review-camera"');
  const reviewCard = html.slice(reviewStart);
  assert.equal(reviewStart > 0, true);
  assert.match(html, /\/api\/cameras\/' \+ encodeURIComponent\(selectedReviewId\) \+ '\/review/);
  assert.match(html, /\/api\/cameras\/' \+ encodeURIComponent\(selectedSuccessId\) \+ '\/success/);
  assert.match(html, /Confirm review/);
  assert.match(html, /Review confirmed\. Continue to Success\. No stream was opened\./);
  assert.match(html, /The last test failed\. Review was not saved\./);
  assert.match(html, /Review is available after a passed test\./);
  assert.match(html, /Mark ready/);
  assert.match(html, /Onboarding complete\. This camera is ready for Live View in a later unit\. No stream was opened\./);
  assert.match(html, /Confirm review before Success\./);
  assert.match(html, /The last test failed\. The camera was not marked ready\./);
  assert.match(html, /Name', camera\.name/);
  assert.match(html, /Profile', camera\.profileLabel/);
  assert.match(html, /Last test', lastTest/);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  assert.equal(/type="password"|name="password"|name="username"/i.test(reviewCard), false);
  assert.equal(html.includes('<video'), false);
  assert.equal(html.includes('result.textContent = data'), false);
  assert.equal(html.includes('result.textContent = JSON.stringify'), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(html), false);
  assert.equal(/GetStreamUri|rtsp:|webrtc/i.test(html), false);
  assert.equal(html.includes(sentinel), false);
});
