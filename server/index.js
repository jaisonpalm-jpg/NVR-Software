import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCameraStore } from './persistence.js';
import { discoverOnvif, parseDiscoverRequest, toDiscoverResponse } from './onvif-discover.js';
import { authContract, parseAuthenticateRequest, runAuthenticate } from './onvif-auth.js';
import { configureContract, interrogateContract } from './onvif-interrogate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDbPath = process.env.VMS_DB_PATH || path.join(root, 'data', 'vms.sqlite');
const MAX_BODY = 64 * 1024;

const TEST_STUB = Object.freeze({
  ok: true,
  contract: 'onvif.test.v0',
  implemented: false,
  checks: Object.freeze([
    Object.freeze({ name: 'network', status: 'not_run' }),
    Object.freeze({ name: 'authentication', status: 'not_run' }),
    Object.freeze({ name: 'onvif', status: 'not_run' }),
    Object.freeze({ name: 'mainStream', status: 'not_run' }),
    Object.freeze({ name: 'substream', status: 'not_run' }),
    Object.freeze({ name: 'ptz', status: 'not_run' }),
    Object.freeze({ name: 'audio', status: 'not_run' }),
    Object.freeze({ name: 'events', status: 'not_run' })
  ])
});

export function startServer({
  port = Number(process.env.PORT || 8787),
  host = '127.0.0.1',
  dbPath = defaultDbPath,
  discoverOptions = {},
  authOptions = {},
  interrogateOptions = {}
} = {}) {
  const store = createCameraStore(dbPath);
  const server = http.createServer((req, res) => {
    dispatch(req, res, store, discoverOptions, authOptions, interrogateOptions).catch((err) => {
      if (res.headersSent) return;
      const status = err.code === 'VALIDATION' ? 400 : err.code === 'LIMIT' ? 413 : 500;
      const error = err.code === 'VALIDATION'
        ? 'invalid_request'
        : err.code === 'LIMIT'
          ? 'payload_too_large'
          : 'internal_error';
      if (status === 500) {
        console.error('request failed', req.method, requestPath(req));
      }
      sendJson(res, status, { ok: false, error });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        store,
        host,
        port: server.address().port
      });
    });
  });
}

async function dispatch(req, res, store, discoverOptions, authOptions, interrogateOptions) {
  const pathname = requestPath(req);

  if (req.method === 'GET' && pathname === '/api/cameras') {
    sendJson(res, 200, await store.list());
    return;
  }

  const interrogateMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/interrogate$/);
  if (req.method === 'POST' && interrogateMatch) {
    await readBody(req);
    const id = decodeId(interrogateMatch[1]);
    const outcome = await store.interrogate(id, interrogateOptions);
    sendInterrogate(res, id, outcome);
    return;
  }

  const configureMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/configure$/);
  if (req.method === 'POST' && configureMatch) {
    const body = await readBody(req);
    const id = decodeId(configureMatch[1]);
    const outcome = await store.saveConfigured(id, configureFields(body));
    sendConfigure(res, outcome);
    return;
  }

  const streamMatch = pathname.match(/^\/api\/cameras\/([^/]+)\/stream$/);
  if (req.method === 'GET' && streamMatch) {
    const camera = await store.get(decodeId(streamMatch[1]));
    if (!camera) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      cameraId: camera.id,
      stream: null,
      delivery: 'unavailable',
      detail: 'Live video is not implemented in this unit.'
    });
    return;
  }

  const cameraMatch = pathname.match(/^\/api\/cameras\/([^/]+)$/);
  if (req.method === 'GET' && cameraMatch) {
    const camera = await store.get(decodeId(cameraMatch[1]));
    if (!camera) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    sendJson(res, 200, camera);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/cameras') {
    const body = await readBody(req);
    const camera = await store.create(body);
    sendJson(res, 201, camera);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/onvif/discover') {
    const body = await readBody(req);
    const request = parseDiscoverRequest(body);
    const devices = await discoverOnvif({
      createSocket: discoverOptions.createSocket,
      timeoutMs: request.timeoutMs ?? discoverOptions.timeoutMs,
      targets: request.targets
    });
    sendJson(res, 200, toDiscoverResponse(devices));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/onvif/authenticate') {
    const body = await readBody(req);
    const request = parseAuthenticateRequest(body);
    const outcome = await runAuthenticate(request, authOptions);
    if (!outcome.ok) {
      const error = outcome.error === 'auth_failed' ? 'auth_failed' : 'unreachable';
      sendJson(res, error === 'auth_failed' ? 401 : 502, {
        ok: false,
        contract: authContract(),
        authenticated: false,
        error
      });
      return;
    }
    const camera = await store.saveAuthenticated(request);
    sendJson(res, 200, {
      ok: true,
      contract: authContract(),
      authenticated: true,
      cameraId: camera.id
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/onvif/test') {
    await readBody(req);
    sendJson(res, 200, TEST_STUB);
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(root, 'index.html'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(html);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
}

function configureFields(body) {
  const fields = {
    name: body?.name,
    site: body?.site,
    group: body?.group
  };
  if (body && Object.prototype.hasOwnProperty.call(body, 'profileId')) {
    fields.profileId = body.profileId;
  }
  return fields;
}

function sendInterrogate(res, id, outcome) {
  if (outcome.error === 'not_found') {
    sendJson(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  if (outcome.error === 'not_authenticated') {
    sendJson(res, 409, { ok: false, contract: interrogateContract(), error: 'not_authenticated' });
    return;
  }
  if (outcome.error) {
    const error = outcome.error === 'auth_failed' ? 'auth_failed' : 'unreachable';
    sendJson(res, error === 'auth_failed' ? 401 : 502, {
      ok: false,
      contract: interrogateContract(),
      error
    });
    return;
  }
  const info = outcome.info || {};
  const payload = {
    ok: true,
    contract: interrogateContract(),
    cameraId: id,
    profiles: Array.isArray(info.profiles) ? info.profiles : []
  };
  if (info.manufacturer) payload.manufacturer = info.manufacturer;
  if (info.model) payload.model = info.model;
  if (info.firmware) payload.firmware = info.firmware;
  sendJson(res, 200, payload);
}

function sendConfigure(res, outcome) {
  if (outcome.error === 'not_found') {
    sendJson(res, 404, { ok: false, error: 'not_found' });
    return;
  }
  if (outcome.error === 'not_authenticated' || outcome.error === 'not_interrogated') {
    sendJson(res, 409, { ok: false, contract: configureContract(), error: outcome.error });
    return;
  }
  if (outcome.error) {
    sendJson(res, 400, { ok: false, contract: configureContract(), error: 'invalid_request' });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    contract: configureContract(),
    camera: outcome.camera
  });
}

function requestPath(req) {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function decodeId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload_too_large'), { code: 'LIMIT' }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('invalid_request'), { code: 'VALIDATION' }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('invalid_request'), { code: 'VALIDATION' }));
      }
    });
    req.on('error', () => {
      reject(Object.assign(new Error('invalid_request'), { code: 'VALIDATION' }));
    });
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then(({ host, port }) => {
    console.log(`VMS frontend http://${host}:${port}`);
    console.log(`VMS API      http://${host}:${port}/api/cameras`);
  });
}
