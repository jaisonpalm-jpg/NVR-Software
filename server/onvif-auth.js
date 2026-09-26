import { createHash, randomBytes } from 'node:crypto';

/**
 * ONVIF device-service authentication.
 *
 * Proves a username and password by calling GetDeviceInformation with a
 * WS-Security UsernameToken password digest. The raw password is not written
 * into the SOAP body, the result, or logs.
 *
 * This module does not resolve stream URIs or open media.
 * A host with no camera LAN returns unreachable. Tests pass fetchImpl or a
 * client to startServer instead of contacting a device.
 */

const CONTRACT = 'onvif.authenticate.v0';
const DEFAULT_PATH = '/onvif/device_service';
const DEFAULT_TIMEOUT_MS = 4000;
const PASSWORD_DIGEST_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64_ENCODING = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

export function authContract() {
  return CONTRACT;
}

export function parseAuthenticateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  return {
    host: requireHost(body.host),
    port: requirePort(body.port),
    scheme: body.scheme === undefined || body.scheme === null || body.scheme === ''
      ? 'http'
      : requireScheme(body.scheme),
    path: body.path === undefined || body.path === null || body.path === ''
      ? DEFAULT_PATH
      : requirePath(body.path),
    username: requireUsername(body.username),
    password: requirePassword(body.password),
    name: body.name === undefined || body.name === null || body.name === ''
      ? null
      : requireName(body.name)
  };
}

export function passwordDigest(nonce, created, password) {
  const nonceBytes = Buffer.isBuffer(nonce) ? nonce : Buffer.from(String(nonce), 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([
      nonceBytes,
      Buffer.from(String(created), 'utf8'),
      Buffer.from(String(password), 'utf8')
    ]))
    .digest('base64');
}

export function buildDeviceInformationEnvelope(username, password, options = {}) {
  const created = options.created || new Date().toISOString();
  const nonce = Buffer.isBuffer(options.nonce) ? options.nonce : randomBytes(16);
  const digest = passwordDigest(nonce, created, password);
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
  <s:Header>
    <wsse:Security s:mustUnderstand="1">
      <wsse:UsernameToken>
        <wsse:Username>${xmlEscape(String(username))}</wsse:Username>
        <wsse:Password Type="${PASSWORD_DIGEST_TYPE}">${digest}</wsse:Password>
        <wsse:Nonce EncodingType="${BASE64_ENCODING}">${nonce.toString('base64')}</wsse:Nonce>
        <wsu:Created>${xmlEscape(created)}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>
  </s:Header>
  <s:Body>
    <tds:GetDeviceInformation/>
  </s:Body>
</s:Envelope>`;
}

export function interpretDeviceService(status, text) {
  const body = typeof text === 'string' ? text : '';
  const authRejected = status === 401
    || status === 403
    || /NotAuthorized|FailedAuthentication|InvalidSecurity|FailedCheck|not authorized|authentication failed|security token/i.test(body);
  if (authRejected) return { ok: false, error: 'auth_failed' };
  const fault = /<\s*(?:[\w.-]+:)?Fault\b/i.test(body);
  if (status === 200 && /GetDeviceInformationResponse/i.test(body) && !fault) {
    return { ok: true };
  }
  return { ok: false, error: 'unreachable' };
}

export function deviceServiceUrl(target) {
  const scheme = target?.scheme === 'https' ? 'https' : 'http';
  const host = typeof target?.host === 'string' ? target.host : '';
  const port = target?.port;
  const path = typeof target?.path === 'string' && target.path.startsWith('/')
    ? target.path
    : DEFAULT_PATH;
  if (!host || host.includes('@') || host.includes('/') || host.includes(' ') || !Number.isInteger(port)) {
    invalid();
  }
  return `${scheme}://${host}:${port}${path}`;
}

export async function callDeviceService(target, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = clampTimeout(options.timeoutMs);
  let url;
  let body;
  try {
    url = deviceServiceUrl(target);
    body = buildDeviceInformationEnvelope(target.username, target.password);
  } catch {
    return { ok: false, error: 'unreachable' };
  }
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
    return interpretDeviceService(response && response.status, text);
  } catch {
    return { ok: false, error: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function runAuthenticate(request, authOptions = {}) {
  const client = typeof authOptions.client === 'function'
    ? authOptions.client
    : (target) => callDeviceService(target, {
      fetchImpl: authOptions.fetchImpl,
      timeoutMs: authOptions.timeoutMs
    });
  try {
    const result = await client({
      host: request.host,
      port: request.port,
      path: request.path,
      scheme: request.scheme,
      username: request.username,
      password: request.password
    });
    if (result && result.ok === true) return { ok: true };
    if (result && result.error === 'auth_failed') return { ok: false, error: 'auth_failed' };
    return { ok: false, error: 'unreachable' };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

function requireHost(value) {
  if (typeof value !== 'string') invalid();
  const host = value.trim();
  if (!host || host.length > 253) invalid();
  if (host.includes('@') || host.includes('/') || host.includes('\\') || /\s/.test(host)) invalid();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map((part) => Number(part));
    if (parts.some((part) => part > 255)) invalid();
    return host;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(host)) {
    invalid();
  }
  return host;
}

function requirePort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) invalid();
  return value;
}

function requireScheme(value) {
  if (value !== 'http' && value !== 'https') invalid();
  return value;
}

function requirePath(value) {
  if (typeof value !== 'string') invalid();
  if (!value.startsWith('/') || value.length > 200) invalid();
  if (value.includes('..') || value.includes('@') || value.includes('\\') || /[\s?#]/.test(value)) invalid();
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(value)) invalid();
  return value;
}

function requireUsername(value) {
  if (typeof value !== 'string') invalid();
  const username = value.trim();
  if (!username || username.length > 128) invalid();
  if (/[\u0000-\u001F\u007F]/.test(username)) invalid();
  return username;
}

function requirePassword(value) {
  if (typeof value !== 'string') invalid();
  if (!value || value.length > 256) invalid();
  if (value.includes('\u0000')) invalid();
  return value;
}

function requireName(value) {
  if (typeof value !== 'string') invalid();
  const redacted = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
    '$1'
  ).trim();
  if (!redacted || redacted.length > 120) invalid();
  return redacted;
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

function invalid() {
  const err = new Error('invalid_request');
  err.code = 'VALIDATION';
  throw err;
}
