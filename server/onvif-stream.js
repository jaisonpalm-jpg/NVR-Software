import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildOnvifEnvelope, mediaServiceUrl } from './onvif-interrogate.js';
import { deviceServiceUrl } from './onvif-auth.js';

/**
 * Live View media path for a ready camera.
 *
 * GetStreamUri runs with the stored login. The media URI stays on the
 * server and is pulled into JPEG frames for a same-origin proxy. Public
 * payloads only name that proxy path. Tests pass client or frameSource
 * instead of contacting a device. A host with no camera LAN, or without a
 * frame puller, fails closed and does not return the URI.
 */

const STREAM_CONTRACT = 'onvif.stream.v0';
const DEFAULT_TIMEOUT_MS = 4000;
const FIRST_FRAME_MS = 8000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export function streamContract() {
  return STREAM_CONTRACT;
}

export function publicStreamPayload(cameraId, profileId) {
  return {
    ok: true,
    contract: STREAM_CONTRACT,
    cameraId,
    stream: `/api/cameras/${encodeURIComponent(cameraId)}/live`,
    delivery: 'mjpeg',
    profileId
  };
}

export function publicStreamError(error) {
  const allowed = new Set([
    'not_found',
    'not_authenticated',
    'not_ready',
    'missing_profile',
    'auth_failed',
    'unreachable',
    'stream_unavailable'
  ]);
  const code = allowed.has(error) ? error : 'unreachable';
  let status = 409;
  if (code === 'not_found') status = 404;
  else if (code === 'auth_failed') status = 401;
  else if (code === 'unreachable' || code === 'stream_unavailable') status = 502;
  return {
    status,
    body: {
      ok: false,
      contract: STREAM_CONTRACT,
      error: code
    }
  };
}

export function buildGetStreamUriBody(profileId) {
  return `<trt:GetStreamUri><trt:StreamSetup><tt:Stream xmlns:tt="http://www.onvif.org/ver10/schema">RTP-Unicast</tt:Stream><tt:Transport xmlns:tt="http://www.onvif.org/ver10/schema"><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${xmlEscape(String(profileId))}</trt:ProfileToken></trt:GetStreamUri>`;
}

export function parseMediaUri(xml) {
  const match = String(xml || '').match(
    /<(?:[A-Za-z0-9_.-]+:)?Uri\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?Uri>/i
  );
  if (!match) return '';
  return decodeXml(match[1].replace(/<[^>]+>/g, '')).trim();
}

export function normalizeSourceUrl(raw, expectedHost) {
  if (typeof raw !== 'string' || typeof expectedHost !== 'string' || !expectedHost) return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001F\u007F\s]/.test(trimmed)) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(url.protocol)) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.toLowerCase() !== expectedHost.toLowerCase()) return null;
  return {
    protocol: url.protocol,
    hostname,
    port: url.port,
    username: decodeURIComponentSafe(url.username),
    password: decodeURIComponentSafe(url.password),
    pathname: url.pathname || '/',
    search: url.search || ''
  };
}

export function composePullUrl(source, username, password) {
  if (!source || typeof source !== 'object') failPull();
  const url = new URL(`${source.protocol}//${source.hostname}`);
  if (source.port) url.port = source.port;
  url.pathname = typeof source.pathname === 'string' && source.pathname ? source.pathname : '/';
  url.search = typeof source.search === 'string' ? source.search : '';
  const embeddedUser = typeof source.username === 'string' ? source.username : '';
  const user = embeddedUser || (typeof username === 'string' ? username : '');
  const pass = embeddedUser
    ? (typeof source.password === 'string' ? source.password : '')
    : (typeof password === 'string' ? password : '');
  if (user) {
    url.username = user;
    url.password = pass;
  }
  return url.toString();
}

export async function callMediaStream(target, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = clampTimeout(options.timeoutMs);
  let deviceUrl;
  try {
    deviceUrl = deviceServiceUrl(target);
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  const capsBody = buildOnvifEnvelope(
    target.username,
    target.password,
    '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>'
  );
  const caps = await postSoap(fetchImpl, deviceUrl, capsBody, timeoutMs);
  const capsResult = interpretCall(caps.status, caps.text, 'GetCapabilitiesResponse');
  if (!capsResult.ok) return capsResult;
  const mediaUrl = mediaServiceUrl(caps.text, target);
  if (!mediaUrl) return { ok: false, error: 'unreachable' };
  const uriBody = buildOnvifEnvelope(target.username, target.password, buildGetStreamUriBody(target.profileId));
  const listed = await postSoap(fetchImpl, mediaUrl, uriBody, timeoutMs);
  const listedResult = interpretCall(listed.status, listed.text, 'GetStreamUriResponse');
  if (!listedResult.ok) return listedResult;
  const sourceUrl = parseMediaUri(listed.text);
  if (!sourceUrl) return { ok: false, error: 'unreachable' };
  return { ok: true, sourceUrl };
}

export async function runGetStreamUri(target, options = {}) {
  const client = typeof options.client === 'function'
    ? options.client
    : (device) => callMediaStream(device, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs
    });
  try {
    const result = await client({
      host: target.host,
      port: target.port,
      path: target.path,
      scheme: target.scheme,
      username: target.username,
      password: target.password,
      profileId: target.profileId
    });
    if (!result || result.ok !== true) {
      return { ok: false, error: result && result.error === 'auth_failed' ? 'auth_failed' : 'unreachable' };
    }
    const source = normalizeSourceUrl(result.sourceUrl, target.host);
    if (!source) return { ok: false, error: 'unreachable' };
    return { ok: true, source };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

export function findFfmpeg(explicit) {
  if (explicit === false) return null;
  if (typeof explicit === 'string' && explicit) {
    try {
      fs.accessSync(explicit, fs.constants.X_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function startPull(source, options = {}) {
  const signal = options.signal;
  if (typeof options.frameSource === 'function') {
    const produced = await options.frameSource({
      cameraId: options.cameraId,
      profileId: options.profileId,
      signal
    });
    if (!produced || typeof produced[Symbol.asyncIterator] !== 'function') failPull();
    return produced;
  }
  const ffmpegPath = findFfmpeg(options.ffmpegPath);
  if (!ffmpegPath) failPull();
  let pullTarget;
  try {
    pullTarget = composePullUrl(source, options.username, options.password);
  } catch {
    failPull();
  }
  const stdout = spawnMjpeg(ffmpegPath, pullTarget, signal);
  if (!stdout) failPull();
  return readJpegs(stdout, signal);
}

export async function writeMjpeg(res, frames, signal) {
  const boundary = 'vmsframe';
  let started = false;
  for await (const frame of frames) {
    if (signal && signal.aborted) break;
    if (!isJpeg(frame) || frame.length > MAX_FRAME_BYTES) continue;
    if (!started) {
      res.writeHead(200, {
        'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      started = true;
    }
    res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write('\r\n');
  }
  if (!started) failPull();
  if (!res.writableEnded) res.end();
}

export function isJpeg(frame) {
  return Buffer.isBuffer(frame)
    && frame.length >= 4
    && frame[0] === 0xff
    && frame[1] === 0xd8
    && frame[frame.length - 2] === 0xff
    && frame[frame.length - 1] === 0xd9;
}

export function firstFrameMs() {
  return FIRST_FRAME_MS;
}

function spawnMjpeg(ffmpegPath, pullTarget, signal) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (pullTarget.startsWith('rtsp:') || pullTarget.startsWith('rtsps:')) {
    args.push('-rtsp_transport', 'tcp');
  }
  args.push('-i', pullTarget, '-an', '-f', 'mjpeg', '-q:v', '8', 'pipe:1');
  let child;
  try {
    child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const kill = () => {
    if (child && child.exitCode == null && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* the process is already gone */
      }
    }
  };
  child.on('error', () => {});
  if (signal) {
    if (signal.aborted) kill();
    else signal.addEventListener('abort', kill, { once: true });
  }
  return child.stdout || null;
}

async function* readJpegs(stream, signal) {
  const pending = [];
  let buffered = Buffer.alloc(0);
  const iterator = stream[Symbol.asyncIterator]();
  while (!signal || !signal.aborted) {
    const step = await iterator.next();
    if (step.done) break;
    buffered = Buffer.concat([buffered, Buffer.from(step.value)]);
    if (buffered.length > MAX_FRAME_BYTES * 2) {
      const restart = buffered.lastIndexOf(Buffer.from([0xff, 0xd8]));
      buffered = restart >= 0 ? buffered.subarray(restart) : Buffer.alloc(0);
    }
    while (buffered.length >= 4) {
      const start = buffered.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        buffered = Buffer.alloc(0);
        break;
      }
      if (start > 0) buffered = buffered.subarray(start);
      const end = buffered.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) break;
      pending.push(Buffer.from(buffered.subarray(0, end + 2)));
      buffered = buffered.subarray(end + 2);
    }
    while (pending.length) yield pending.shift();
  }
}

function interpretCall(status, text, responseName) {
  const body = typeof text === 'string' ? text : '';
  const authRejected = status === 401
    || status === 403
    || /NotAuthorized|FailedAuthentication|InvalidSecurity|FailedCheck|not authorized|authentication failed|security token/i.test(body);
  if (authRejected) return { ok: false, error: 'auth_failed' };
  const fault = /<\s*(?:[\w.-]+:)?Fault\b/i.test(body);
  const matched = new RegExp(responseName, 'i').test(body);
  if (status === 200 && matched && !fault) return { ok: true };
  return { ok: false, error: 'unreachable' };
}

async function postSoap(fetchImpl, url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
      body,
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store'
    });
    const text = response && typeof response.text === 'function' ? await response.text() : '';
    return { status: response && response.status, text: typeof text === 'string' ? text : '' };
  } catch {
    return { status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlEscape(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clampTimeout(value) {
  if (!Number.isInteger(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(10000, Math.max(100, value));
}

function failPull() {
  throw Object.assign(new Error('stream_unavailable'), { code: 'NO_FRAMES' });
}
