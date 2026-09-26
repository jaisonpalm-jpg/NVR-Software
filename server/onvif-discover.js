import dgram from 'node:dgram';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * ONVIF WS-Discovery probe.
 *
 * Sends SOAP-over-UDP Probe messages to 239.255.255.250:3702 (and, when the
 * request names one host, a unicast Probe to that host). Devices are parsed
 * from ProbeMatches. Nothing is written to the camera store.
 *
 * The request body is not a credential form. username, password, and any
 * other unrecognized fields are ignored and never copied into the result.
 */

const WS_DISCOVERY_ADDRESS = '239.255.255.250';
const WS_DISCOVERY_PORT = 3702;
const DEFAULT_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5000;
const MAX_DATAGRAM = 64 * 1024;
const MAX_DEVICES = 64;
const CONTRACT = 'onvif.discover.v0';

const PROBE_ACTION = 'http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe';

export function parseDiscoverRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const timeoutMs = body.timeoutMs === undefined ? undefined : requireTimeout(body.timeoutMs);
  const targets = parseTarget(body);
  return { timeoutMs, targets };
}

export function buildProbeMessages() {
  const networkId = `uuid:${randomUUID()}`;
  const deviceId = `uuid:${randomUUID()}`;
  return [
    {
      id: networkId,
      xml: probeXml(networkId, 'dn:NetworkVideoTransmitter', 'xmlns:dn="http://www.onvif.org/ver10/network/wsdl"')
    },
    {
      id: deviceId,
      xml: probeXml(deviceId, 'tds:Device', 'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"')
    }
  ];
}

export function parseProbeMatches(xml, messageIds) {
  const text = String(xml || '').replace(/^\uFEFF/, '');
  if (!/ProbeMatches/i.test(text)) return [];
  const relates = firstLocalText(text, 'RelatesTo');
  if (relates && messageIds && !relatesToProbe(relates, messageIds)) return [];

  const devices = [];
  for (const block of extractBlocks(text, 'ProbeMatch')) {
    const device = deviceFromBlock(block);
    if (device) devices.push(device);
  }
  return devices;
}

export function toDiscoverResponse(devices) {
  const list = Array.isArray(devices) ? devices.slice(0, MAX_DEVICES) : [];
  return {
    ok: true,
    contract: CONTRACT,
    implemented: true,
    devices: list.map(publicDevice)
  };
}

export function discoverOnvif(options = {}) {
  return runDiscovery(options).catch(() => []);
}

function runDiscovery(options) {
  const timeoutMs = clampTimeout(options.timeoutMs);
  const targets = Array.isArray(options.targets) && options.targets.length
    ? options.targets
    : null;
  const probes = buildProbeMessages();
  const messageIds = new Set(probes.map((probe) => probe.id));
  const interfaces = (options.createSocket || targets) ? [null] : localIpv4Interfaces();

  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      resolve([...found.values()].slice(0, MAX_DEVICES));
    };

    const timer = setTimeout(finish, timeoutMs);

    for (const iface of interfaces) {
      let socket;
      try {
        socket = options.createSocket
          ? options.createSocket()
          : dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch {
        continue;
      }
      sockets.push(socket);
      socket.on('error', () => {});
      socket.on('message', (msg, rinfo) => {
        ingest(found, msg, rinfo, messageIds);
      });

      const sendProbes = () => {
        if (settled) return;
        try {
          socket.setBroadcast?.(true);
          socket.setMulticastTTL?.(2);
          if (!targets) joinMulticast(socket, iface);
        } catch {
          /* membership is best-effort; an empty LAN still returns [] */
        }
        const destinations = targets || [{ host: WS_DISCOVERY_ADDRESS, port: WS_DISCOVERY_PORT }];
        for (const destination of destinations) {
          for (const probe of probes) {
            try {
              socket.send(Buffer.from(probe.xml), destination.port, destination.host, () => {});
            } catch {
              /* one failed send does not fail the probe */
            }
          }
        }
      };

      try {
        if (iface) socket.bind(0, iface, sendProbes);
        else socket.bind(0, sendProbes);
      } catch {
        /* bind failure: wait out the timeout and return whatever arrived */
      }
    }

    if (!sockets.length) finish();
  });
}

function joinMulticast(socket, iface) {
  try {
    if (iface) socket.addMembership(WS_DISCOVERY_ADDRESS, iface);
    else socket.addMembership(WS_DISCOVERY_ADDRESS);
  } catch {
    /* cloud and container hosts often have no multicast route */
  }
  if (!iface || typeof socket.setMulticastInterface !== 'function') return;
  try {
    socket.setMulticastInterface(iface);
  } catch {
    /* interface may not support multicast */
  }
}

function ingest(found, msg, rinfo, messageIds) {
  const buf = Buffer.isBuffer(msg) ? msg.subarray(0, MAX_DATAGRAM) : Buffer.from(String(msg || '')).subarray(0, MAX_DATAGRAM);
  const text = buf.toString('utf8');
  for (const device of parseProbeMatches(text, messageIds)) {
    if (!device.address && rinfo && typeof rinfo.address === 'string') {
      const address = presentationAddress(rinfo.address);
      if (address) device.address = address;
    }
    if (!device.address || found.size >= MAX_DEVICES) continue;
    const key = device.probe.endpoint || device.probe.xaddrs[0] || device.address;
    if (!found.has(key)) found.set(key, device);
  }
}

function deviceFromBlock(block) {
  const endpoint = clean(firstLocalText(block, 'Address'), 200) || null;
  const types = splitTokens(localTexts(block, 'Types').join(' ')).slice(0, 16);
  const scopeInfo = interpretScopes(localTexts(block, 'Scopes').join(' '));
  const xaddrs = splitTokens(localTexts(block, 'XAddrs').join(' '))
    .map(sanitizeHttpUrl)
    .filter(Boolean)
    .slice(0, 8);
  const versionRaw = firstLocalText(block, 'MetadataVersion');
  const metadataVersion = /^\d{1,9}$/.test(versionRaw) ? Number(versionRaw) : null;
  const primary = xaddrs[0] ? endpointFromXaddr(xaddrs[0]) : { address: null, port: null };

  return {
    address: primary.address,
    port: primary.port,
    name: scopeInfo.name,
    manufacturer: scopeInfo.manufacturer,
    model: scopeInfo.model,
    probe: {
      endpoint,
      types,
      metadataVersion,
      xaddrs,
      scopes: scopeInfo.scopes
    }
  };
}

function publicDevice(device) {
  const probe = device?.probe && typeof device.probe === 'object' ? device.probe : {};
  return {
    address: typeof device?.address === 'string' ? device.address : null,
    port: Number.isInteger(device?.port) ? device.port : null,
    name: typeof device?.name === 'string' ? device.name : null,
    manufacturer: typeof device?.manufacturer === 'string' ? device.manufacturer : null,
    model: typeof device?.model === 'string' ? device.model : null,
    probe: {
      endpoint: typeof probe.endpoint === 'string' ? probe.endpoint : null,
      types: stringList(probe.types),
      metadataVersion: Number.isInteger(probe.metadataVersion) ? probe.metadataVersion : null,
      xaddrs: stringList(probe.xaddrs),
      scopes: stringList(probe.scopes)
    }
  };
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

function probeXml(messageId, types, typeNamespace) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ${typeNamespace}>
  <e:Header>
    <w:MessageID>${messageId}</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>${PROBE_ACTION}</w:Action>
    <w:ReplyTo><w:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</w:Address></w:ReplyTo>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>${types}</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>`;
}

function interpretScopes(text) {
  let name = null;
  let model = null;
  let manufacturer = null;
  const scopes = [];
  for (const token of splitTokens(text)) {
    const safe = sanitizeScope(token);
    if (!safe) continue;
    scopes.push(safe);
    if (!name) name = scopeField(safe, 'name');
    if (!model) model = scopeField(safe, 'hardware');
    if (!manufacturer) manufacturer = scopeField(safe, 'manufacturer') || scopeField(safe, 'mfr');
  }
  return {
    name,
    model,
    manufacturer,
    scopes: scopes.slice(0, 32)
  };
}

function scopeField(scope, key) {
  const match = scope.match(new RegExp(`^onvif://www\\.onvif\\.org/${key}/(.+)$`, 'i'));
  if (!match) return null;
  let value = match[1];
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw token */
  }
  return clean(value, 120) || null;
}

function sanitizeScope(scope) {
  const text = clean(scope, 300);
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'onvif:' && url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/pass|secret|token|credential|user/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function sanitizeHttpUrl(raw) {
  const text = clean(raw, 500);
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/pass|secret|token|credential|user/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function endpointFromXaddr(xaddr) {
  try {
    const url = new URL(xaddr);
    const address = presentationAddress(url.hostname);
    if (!address) return { address: null, port: null };
    const port = url.port
      ? Number(url.port)
      : (url.protocol === 'https:' ? 443 : 80);
    return { address, port };
  } catch {
    return { address: null, port: null };
  }
}

function presentationAddress(value) {
  const text = clean(value, 253);
  if (!text || text.includes('@') || text.includes('/') || text.includes(' ')) return null;
  return text;
}

function splitTokens(value) {
  return String(value || '').split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

function firstLocalText(xml, localName) {
  return localTexts(xml, localName)[0] || '';
}

function localTexts(xml, localName) {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`,
    'gi'
  );
  const values = [];
  for (const match of xml.matchAll(re)) {
    const text = decodeXml(match[1].replace(/<[^>]+>/g, '')).trim();
    if (text) values.push(text);
  }
  return values;
}

function extractBlocks(xml, localName) {
  const open = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>`, 'gi');
  const blocks = [];
  for (const match of xml.matchAll(open)) {
    const start = match.index + match[0].length;
    const rest = xml.slice(start);
    const close = rest.match(new RegExp(`</(?:[A-Za-z0-9_.-]+:)?${localName}>`, 'i'));
    if (!close || close.index === undefined) break;
    blocks.push(rest.slice(0, close.index));
  }
  return blocks;
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

function relatesToProbe(relates, messageIds) {
  const raw = relates.trim();
  for (const id of messageIds) {
    if (raw === id) return true;
    const uuid = id.startsWith('uuid:') ? id.slice(5) : id;
    if (uuid.length >= 32 && raw.includes(uuid)) return true;
  }
  return false;
}

function parseTarget(body) {
  const hasHost = body.host !== undefined && body.host !== null && body.host !== '';
  const hasPort = body.port !== undefined && body.port !== null && body.port !== '';
  if (!hasHost && !hasPort) return null;
  if (!hasHost) invalid();
  return [{ host: requireHost(body.host), port: hasPort ? requirePort(body.port) : WS_DISCOVERY_PORT }];
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

function requireTimeout(value) {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) invalid();
  return value;
}

function clampTimeout(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, value));
}

function localIpv4Interfaces() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = entry.family;
      if ((family === 'IPv4' || family === 4) && !entry.internal && entry.address) {
        found.push(entry.address);
      }
    }
  }
  return found.length ? found : [null];
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/[<>]/g, '').trim().slice(0, max);
}

function invalid() {
  const err = new Error('invalid_request');
  err.code = 'VALIDATION';
  throw err;
}
