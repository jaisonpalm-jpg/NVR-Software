import { randomBytes } from 'node:crypto';
import { deviceServiceUrl, passwordDigest } from './onvif-auth.js';

/**
 * ONVIF interrogation for configure.
 *
 * Uses a stored username and password to call GetDeviceInformation,
 * GetCapabilities, and GetProfiles when a same-host media service is
 * advertised. The raw password is not written into the SOAP body. Stream
 * URIs are not requested and are not returned. Tests pass fetchImpl or a
 * client instead of contacting a device.
 */

const INTERROGATE_CONTRACT = 'onvif.interrogate.v0';
const CONFIGURE_CONTRACT = 'onvif.configure.v0';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_PROFILES = 16;
const PASSWORD_DIGEST_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64_ENCODING = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

export function interrogateContract() {
  return INTERROGATE_CONTRACT;
}

export function configureContract() {
  return CONFIGURE_CONTRACT;
}

export function buildOnvifEnvelope(username, password, bodyInner, options = {}) {
  const created = options.created || new Date().toISOString();
  const nonce = Buffer.isBuffer(options.nonce) ? options.nonce : randomBytes(16);
  const digest = passwordDigest(nonce, created, password);
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
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
    ${bodyInner}
  </s:Body>
</s:Envelope>`;
}

export function parseDeviceInformation(xml) {
  return {
    manufacturer: firstLocalText(xml, 'Manufacturer'),
    model: firstLocalText(xml, 'Model'),
    firmware: firstLocalText(xml, 'FirmwareVersion')
  };
}

export function parseProfiles(xml) {
  const profiles = [];
  const seen = new Set();
  const re = /<(?:[A-Za-z0-9_.-]+:)?Profiles\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?Profiles>/gi;
  for (const match of String(xml || '').matchAll(re)) {
    const id = attrValue(match[1], 'token');
    const label = firstLocalText(match[2], 'Name');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    profiles.push({ id, label });
    if (profiles.length >= MAX_PROFILES) break;
  }
  return profiles;
}

export function mediaServiceUrl(xml, target) {
  const blocks = extractBlocks(xml, 'Media');
  for (const block of blocks) {
    const raw = firstLocalText(block, 'XAddr');
    const url = sameHostHttpUrl(raw, target && target.host);
    if (url) return url;
  }
  return null;
}

export async function callDeviceCapabilities(target, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = clampTimeout(options.timeoutMs);
  let deviceUrl;
  try {
    deviceUrl = deviceServiceUrl(target);
  } catch {
    return { ok: false, error: 'unreachable' };
  }

  const infoBody = buildOnvifEnvelope(target.username, target.password, '<tds:GetDeviceInformation/>');
  const info = await postSoap(fetchImpl, deviceUrl, infoBody, timeoutMs);
  const infoResult = interpretCall(info.status, info.text, 'GetDeviceInformationResponse');
  if (!infoResult.ok) return infoResult;

  const device = parseDeviceInformation(info.text);
  let profiles = [];
  const capsBody = buildOnvifEnvelope(
    target.username,
    target.password,
    '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>'
  );
  const caps = await postSoap(fetchImpl, deviceUrl, capsBody, timeoutMs);
  if (interpretCall(caps.status, caps.text, 'GetCapabilitiesResponse').ok) {
    const mediaUrl = mediaServiceUrl(caps.text, target);
    if (mediaUrl) {
      const profilesBody = buildOnvifEnvelope(target.username, target.password, '<trt:GetProfiles/>');
      const listed = await postSoap(fetchImpl, mediaUrl, profilesBody, timeoutMs);
      if (interpretCall(listed.status, listed.text, 'GetProfilesResponse').ok) {
        profiles = parseProfiles(listed.text);
      }
    }
  }

  return {
    ok: true,
    ...acceptDeviceInfo({
      manufacturer: device.manufacturer,
      model: device.model,
      firmware: device.firmware,
      profiles
    }, [target.username, target.password])
  };
}

export async function runInterrogate(target, options = {}) {
  const client = typeof options.client === 'function'
    ? options.client
    : (device) => callDeviceCapabilities(device, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs
    });
  const secrets = [target && target.username, target && target.password];
  try {
    const result = await client({
      host: target.host,
      port: target.port,
      path: target.path,
      scheme: target.scheme,
      username: target.username,
      password: target.password
    });
    if (!result || result.ok !== true) {
      return { ok: false, error: result && result.error === 'auth_failed' ? 'auth_failed' : 'unreachable' };
    }
    return {
      ok: true,
      ...acceptDeviceInfo(result, secrets)
    };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

export function acceptDeviceInfo(result, secrets = []) {
  const profiles = [];
  const seen = new Set();
  const source = Array.isArray(result && result.profiles) ? result.profiles : [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const id = cleanProfileId(entry.id ?? entry.profileId ?? entry.token, secrets);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = cleanLabel(entry.label ?? entry.name, secrets) || id;
    profiles.push({ id, label });
    if (profiles.length >= MAX_PROFILES) break;
  }
  return {
    manufacturer: cleanLabel(result && result.manufacturer, secrets),
    model: cleanLabel(result && result.model, secrets),
    firmware: cleanLabel(result && result.firmware, secrets),
    profiles
  };
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

function sameHostHttpUrl(raw, host) {
  if (typeof raw !== 'string' || !raw.trim() || typeof host !== 'string' || !host) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const name = url.hostname.replace(/^\[|\]$/g, '');
  if (!name || name.toLowerCase() !== host.toLowerCase()) return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

function cleanLabel(value, secrets) {
  return cleanText(value, secrets, 120);
}

function cleanProfileId(value, secrets) {
  const text = cleanText(value, secrets, 128);
  if (!text || /[\s/@\\<>]/.test(text) || text.includes('://')) return null;
  return text;
}

function cleanText(value, secrets, max) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\u0000-\u001F\u007F]/g, '');
  text = text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
    '$1'
  );
  if (/rtsp:|rtsps:|webrtc:|srt:|GetStreamUri/i.test(text)) return null;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 && text.includes(secret)) {
      text = text.split(secret).join('');
    }
  }
  text = text.trim();
  if (!text || text.length > max || /[<>]/.test(text)) return null;
  if (/pass(?:word)?\s*[:=]|secret\s*[:=]/i.test(text)) return null;
  return text;
}

function firstLocalText(xml, localName) {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`,
    'i'
  );
  const match = String(xml || '').match(re);
  if (!match) return '';
  return decodeXml(match[1].replace(/<[^>]+>/g, '')).trim();
}

function extractBlocks(xml, localName) {
  const open = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>`, 'gi');
  const blocks = [];
  for (const match of String(xml || '').matchAll(open)) {
    const start = match.index + match[0].length;
    const rest = xml.slice(start);
    const close = rest.match(new RegExp(`</(?:[A-Za-z0-9_.-]+:)?${localName}>`, 'i'));
    if (!close || close.index === undefined) break;
    blocks.push(rest.slice(0, close.index));
  }
  return blocks;
}

function attrValue(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  if (!match) return '';
  return decodeXml(match[1] ?? match[2] ?? '').trim();
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
