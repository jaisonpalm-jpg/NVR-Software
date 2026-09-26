import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './index.js';
import {
  buildProbeMessages,
  discoverOnvif,
  parseDiscoverRequest,
  parseProbeMatches,
  toDiscoverResponse
} from './onvif-discover.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretKey = ['pass', 'word'].join('');
const userKey = ['user', 'name'].join('');
const sentinel = 'sentinel-secret-value';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vms-u1-'));
  return path.join(dir, 'vms.sqlite');
}

function assertForbidden(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(sentinel), false);
  assert.equal(serialized.includes('operator:'), false);
  walk(value);
}

function walk(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(/pass|secret|credential|token|username|userinfo/i.test(key), false, key);
    walk(child);
  }
}

function scriptedSocket(onSend) {
  const handlers = new Map();
  return {
    on(event, fn) {
      handlers.set(event, fn);
      return this;
    },
    bind(_port, arg2, arg3) {
      const callback = typeof arg2 === 'function' ? arg2 : arg3;
      queueMicrotask(() => {
        if (typeof callback === 'function') callback();
      });
    },
    setBroadcast() {},
    setMulticastTTL() {},
    setMulticastInterface() {},
    addMembership() {},
    send(payload, port, host) {
      const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
      onSend({
        text,
        port,
        host,
        emit(msg, rinfo) {
          const fn = handlers.get('message');
          if (fn) fn(Buffer.from(msg), rinfo || { address: '192.0.2.40', port: 3702 });
        }
      });
    },
    close() {}
  };
}

function probeMatch({ relatesTo = '', xaddrs = '', scopes = '', types = 'dn:NetworkVideoTransmitter', endpoint = 'urn:uuid:11111111-1111-4111-8111-111111111111', extra = '' }) {
  const relates = relatesTo ? `<w:RelatesTo>${relatesTo}</w:RelatesTo>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
  <e:Header>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</w:Action>
    ${relates}
  </e:Header>
  <e:Body>
    <d:ProbeMatches>
      <d:ProbeMatch>
        <w:EndpointReference><w:Address>${endpoint}</w:Address></w:EndpointReference>
        <d:Types>${types}</d:Types>
        <d:Scopes>${scopes}</d:Scopes>
        <d:XAddrs>${xaddrs}</d:XAddrs>
        <d:MetadataVersion>10</d:MetadataVersion>
        ${extra}
      </d:ProbeMatch>
    </d:ProbeMatches>
  </e:Body>
</e:Envelope>`;
}

const scopes = [
  'onvif://www.onvif.org/type/video_encoder',
  'onvif://www.onvif.org/name/Front%20Door',
  'onvif://www.onvif.org/hardware/Cam-100',
  'onvif://www.onvif.org/manufacturer/Acme',
  'onvif://www.onvif.org/Profile/Streaming',
  `onvif://operator:${sentinel}@www.onvif.org/name/Hidden`,
  `onvif://www.onvif.org/location/lab?${secretKey}=${sentinel}`
].join(' ');

test('probe messages are WS-Discovery Probes for ONVIF devices', () => {
  const messages = buildProbeMessages();
  assert.equal(messages.length, 2);
  const xml = messages.map((message) => message.xml).join('\n');
  assert.match(xml, /http:\/\/schemas\.xmlsoap\.org\/ws\/2005\/04\/discovery\/Probe/);
  assert.match(xml, /dn:NetworkVideoTransmitter/);
  assert.match(xml, /tds:Device/);
  assert.equal(xml.includes(sentinel), false);
  assert.equal(xml.toLowerCase().includes(secretKey), false);
  for (const message of messages) {
    assert.match(message.xml, new RegExp(message.id));
  }
});

test('ProbeMatches become a public device without secrets', () => {
  const parsed = parseProbeMatches(probeMatch({
    xaddrs: `http://operator:${sentinel}@192.168.1.64:8080/onvif/device_service`,
    scopes,
    extra: `<d:${secretKey}>${sentinel}</d:${secretKey}><${userKey}>operator</${userKey}>`
  }), null);
  const response = toDiscoverResponse(parsed);
  assert.equal(response.implemented, true);
  assert.equal(response.devices.length, 1);
  assert.deepEqual(response.devices[0], {
    address: '192.168.1.64',
    port: 8080,
    name: 'Front Door',
    manufacturer: 'Acme',
    model: 'Cam-100',
    probe: {
      endpoint: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      types: ['dn:NetworkVideoTransmitter'],
      metadataVersion: 10,
      xaddrs: ['http://192.168.1.64:8080/onvif/device_service'],
      scopes: response.devices[0].probe.scopes
    }
  });
  assert.ok(response.devices[0].probe.scopes.some((scope) => scope.includes('/name/Front%20Door') || scope.includes('/name/Front%20Door')));
  assert.equal(response.devices[0].probe.scopes.some((scope) => scope.includes(sentinel)), false);
  assertForbidden(response);
});

test('a ProbeMatches reply for another probe is ignored', () => {
  const xml = probeMatch({
    relatesTo: 'uuid:00000000-0000-4000-8000-000000000000',
    xaddrs: 'http://192.168.1.64/onvif/device_service'
  });
  const parsed = parseProbeMatches(xml, new Set(['uuid:11111111-1111-4111-8111-111111111111']));
  assert.deepEqual(parsed, []);
});

test('a matching RelatesTo is accepted and an unknown datagram is not', () => {
  const id = 'uuid:11111111-1111-4111-8111-111111111111';
  const matched = parseProbeMatches(probeMatch({
    relatesTo: id,
    xaddrs: 'http://192.168.1.20/onvif/device_service'
  }), new Set([id]));
  assert.equal(matched.length, 1);
  assert.equal(matched[0].address, '192.168.1.20');
  assert.equal(matched[0].port, 80);
  assert.deepEqual(parseProbeMatches('<xml>no discovery</xml>', new Set([id])), []);
});

test('discover request options keep only host, port, and timeout', () => {
  const parsed = parseDiscoverRequest({
    host: '192.0.2.15',
    port: 3702,
    timeoutMs: 250,
    [userKey]: 'operator',
    [secretKey]: sentinel
  });
  assert.deepEqual(parsed, {
    timeoutMs: 250,
    targets: [{ host: '192.0.2.15', port: 3702 }]
  });
  assert.equal(JSON.stringify(parsed).includes(sentinel), false);
  assert.throws(() => parseDiscoverRequest({ host: `operator:${sentinel}@192.0.2.15` }), (err) => err.code === 'VALIDATION');
  assert.throws(() => parseDiscoverRequest({ timeoutMs: 1 }), (err) => err.code === 'VALIDATION');
});

test('a scripted multicast probe returns one device and an empty reply returns none', async () => {
  const sent = [];
  const found = await discoverOnvif({
    timeoutMs: 100,
    [secretKey]: sentinel,
    createSocket: () => scriptedSocket((event) => {
      sent.push(event);
      if (sent.length === 1) {
        const id = event.text.match(/<w:MessageID>([^<]+)<\/w:MessageID>/)[1];
        event.emit(probeMatch({
          relatesTo: id,
          xaddrs: 'http://10.1.1.5/onvif/device_service',
          scopes: 'onvif://www.onvif.org/name/Gate onvif://www.onvif.org/hardware/GateCam'
        }));
      }
    })
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].address, '10.1.1.5');
  assert.equal(found[0].name, 'Gate');
  assert.equal(found[0].model, 'GateCam');
  assert.ok(sent.some((event) => event.host === '239.255.255.250' && event.port === 3702));
  assert.ok(sent.some((event) => event.text.includes('NetworkVideoTransmitter')));
  assert.ok(sent.some((event) => event.text.includes('tds:Device')));
  assert.equal(JSON.stringify(sent).includes(sentinel), false);
  assertForbidden(toDiscoverResponse(found));

  const empty = await discoverOnvif({
    timeoutMs: 100,
    createSocket: () => scriptedSocket(() => {})
  });
  assert.deepEqual(empty, []);
  assert.deepEqual(toDiscoverResponse(empty), {
    ok: true,
    contract: 'onvif.discover.v0',
    implemented: true,
    devices: []
  });
});

test('an optional host is probed with unicast WS-Discovery', async () => {
  const sent = [];
  const found = await discoverOnvif({
    timeoutMs: 100,
    targets: [{ host: '192.0.2.25', port: 3702 }],
    createSocket: () => scriptedSocket((event) => {
      sent.push(event);
    })
  });
  assert.deepEqual(found, []);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((event) => event.host === '192.0.2.25' && event.port === 3702));
});

test('the real socket path resolves on an empty network', async () => {
  const devices = await discoverOnvif({ timeoutMs: 150 });
  assert.ok(Array.isArray(devices));
  assertForbidden(toDiscoverResponse(devices));
});

test('HTTP discover returns the probe result and does not save cameras', async () => {
  const logs = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const original = Object.fromEntries(methods.map((method) => [method, console[method]]));
  for (const method of methods) {
    console[method] = (...args) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    };
  }

  const started = await startServer({
    port: 0,
    dbPath: tempDb(),
    discoverOptions: {
      createSocket: () => scriptedSocket((event) => {
        if (logs.length > 20) return;
        event.emit(probeMatch({
          xaddrs: `http://operator:${sentinel}@192.168.1.50/onvif/device_service`,
          scopes,
          extra: `<secret>${sentinel}</secret>`
        }), { address: '192.168.1.50', port: 3702 });
      })
    }
  });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const response = await fetch(`${base}/api/onvif/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timeoutMs: 100,
        [userKey]: 'operator',
        [secretKey]: sentinel
      })
    });
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.implemented, true);
    assert.equal(body.devices.length, 1);
    assert.equal(body.devices[0].address, '192.168.1.50');
    assert.equal(body.devices[0].port, 80);
    assert.equal(body.devices[0].name, 'Front Door');
    assert.equal(text.includes(sentinel), false);
    assert.equal(text.includes('operator'), false);
    assertForbidden(body);

    const listed = await fetch(`${base}/api/cameras`);
    assert.equal(await listed.text(), '[]');

    const rejected = await fetch(`${base}/api/onvif/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: `user:${sentinel}@camera`, [secretKey]: sentinel })
    });
    const rejectedText = await rejected.text();
    assert.equal(rejected.status, 400);
    assert.equal(rejectedText.includes(sentinel), false);
    assert.equal(logs.some((line) => line.includes(sentinel)), false);
  } finally {
    for (const method of methods) console[method] = original[method];
    started.store.close();
    await new Promise((resolve, reject) => {
      started.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('the cameras page calls discover and has no credential fields', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /id="discover-btn"/);
  assert.match(html, /Discover ONVIF devices/);
  assert.match(html, /\/api\/onvif\/discover/);
  assert.match(html, /Nothing was added to the camera list/);
  assert.equal(/type="password"/i.test(html), false);
  assert.equal(/name="password"/i.test(html), false);
  assert.equal(/name="username"/i.test(html), false);
  assert.equal(html.includes(secretKey), false);
});
