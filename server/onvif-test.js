import net from 'node:net';
import { callDeviceService } from './onvif-auth.js';

/**
 * ONVIF onboarding test for a configured camera.
 *
 * Uses the login already stored for that camera. Network reachability is a
 * TCP connect. Authentication and the device service are a GetDeviceInformation
 * call. Manufacturer, model, and profiles come from the saved interrogation
 * snapshot. Media checks are skipped. This module does not call GetStreamUri
 * and does not open RTSP or WebRTC.
 *
 * A host with no camera LAN fails the network check. Tests pass a client,
 * connectImpl, or fetchImpl instead of contacting a device.
 */

const CONTRACT = 'onvif.test.v0';
const DEFAULT_TIMEOUT_MS = 4000;
const REAL_CHECKS = new Set(['network', 'authentication', 'onvif', 'deviceInfo']);
const MEDIA_CHECKS = Object.freeze(['mainStream', 'substream', 'ptz', 'audio', 'events']);
const CHECK_NAMES = new Set([...REAL_CHECKS, ...MEDIA_CHECKS]);
const CHECK_STATUSES = new Set(['pass', 'fail', 'skipped']);
const CHECK_REASONS = new Set(['unreachable', 'auth_failed', 'no_device_info', 'not_implemented']);

export function testContract() {
  return CONTRACT;
}

export function normalizeProbe(result) {
  if (result && typeof result === 'object') {
    const explicit = ['network', 'authentication', 'onvif'].some((key) => (
      result[key] === 'pass' || result[key] === 'fail'
    ));
    if (explicit) {
      return {
        network: result.network === 'pass' ? 'pass' : 'fail',
        authentication: result.authentication === 'pass' ? 'pass' : 'fail',
        onvif: result.onvif === 'pass' ? 'pass' : 'fail'
      };
    }
    if (result.ok === true) {
      return { network: 'pass', authentication: 'pass', onvif: 'pass' };
    }
    if (result.error === 'auth_failed') {
      return { network: 'pass', authentication: 'fail', onvif: 'pass' };
    }
  }
  return { network: 'fail', authentication: 'fail', onvif: 'fail' };
}

export function deviceInfoStatus(snapshot) {
  const manufacturer = snapshot && typeof snapshot.manufacturer === 'string' && snapshot.manufacturer;
  const model = snapshot && typeof snapshot.model === 'string' && snapshot.model;
  const profiles = snapshot && Array.isArray(snapshot.profiles) ? snapshot.profiles : [];
  const hasProfile = profiles.some((profile) => profile && typeof profile.id === 'string' && profile.id);
  return manufacturer || model || hasProfile ? 'pass' : 'fail';
}

export function buildTestChecks(probe, snapshot) {
  const network = probe && probe.network === 'pass' ? 'pass' : 'fail';
  const authentication = probe && probe.authentication === 'pass' ? 'pass' : 'fail';
  const onvif = probe && probe.onvif === 'pass' ? 'pass' : 'fail';
  const deviceInfo = deviceInfoStatus(snapshot);
  return [
    row('network', network, network === 'fail' ? 'unreachable' : null),
    row(
      'authentication',
      authentication,
      authentication === 'fail' ? (network === 'pass' ? 'auth_failed' : 'unreachable') : null
    ),
    row('onvif', onvif, onvif === 'fail' ? 'unreachable' : null),
    row('deviceInfo', deviceInfo, deviceInfo === 'fail' ? 'no_device_info' : null),
    ...MEDIA_CHECKS.map((name) => row(name, 'skipped', 'not_implemented'))
  ];
}

export function testSummary(checks) {
  const passed = Array.isArray(checks) && checks.every((item) => (
    !item || !REAL_CHECKS.has(item.name) || item.status === 'pass'
  ));
  return passed ? 'passed' : 'failed';
}

export async function runDeviceProbe(target, options = {}) {
  if (typeof options.client === 'function') {
    try {
      const result = await options.client({
        host: target.host,
        port: target.port,
        path: target.path,
        scheme: target.scheme,
        username: target.username,
        password: target.password
      });
      return normalizeProbe(result);
    } catch {
      return normalizeProbe(null);
    }
  }
  return probeLive(target, options);
}

export function publicTestPayload(outcome) {
  if (!outcome || outcome.error) {
    const error = outcome && outcome.error === 'not_found'
      ? 'not_found'
      : outcome && outcome.error === 'not_authenticated'
        ? 'not_authenticated'
        : 'not_configured';
    return {
      status: error === 'not_found' ? 404 : 409,
      body: {
        ok: false,
        contract: CONTRACT,
        implemented: true,
        error
      }
    };
  }
  const summary = outcome.summary === 'passed' ? 'passed' : 'failed';
  return {
    status: 200,
    body: {
      ok: summary === 'passed',
      contract: CONTRACT,
      implemented: true,
      cameraId: outcome.cameraId,
      summary,
      checkedAt: outcome.checkedAt,
      checks: Array.isArray(outcome.checks) ? outcome.checks.map(publicCheck).filter(Boolean) : []
    }
  };
}

async function probeLive(target, options) {
  const timeoutMs = clampTimeout(options.timeoutMs);
  const connectImpl = typeof options.connectImpl === 'function' ? options.connectImpl : tcpReachable;
  let reached = false;
  try {
    reached = await connectImpl(target.host, target.port, timeoutMs) === true;
  } catch {
    reached = false;
  }
  if (!reached) {
    return { network: 'fail', authentication: 'fail', onvif: 'fail' };
  }
  const result = await callDeviceService(target, {
    fetchImpl: options.fetchImpl,
    timeoutMs
  });
  if (result && result.ok === true) {
    return { network: 'pass', authentication: 'pass', onvif: 'pass' };
  }
  if (result && result.error === 'auth_failed') {
    return { network: 'pass', authentication: 'fail', onvif: 'pass' };
  }
  return { network: 'pass', authentication: 'fail', onvif: 'fail' };
}

function tcpReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function publicCheck(item) {
  if (!item || !CHECK_NAMES.has(item.name) || !CHECK_STATUSES.has(item.status)) return null;
  const check = { name: item.name, status: item.status };
  if (CHECK_REASONS.has(item.reason)) check.reason = item.reason;
  return check;
}

function row(name, status, reason) {
  const check = { name, status };
  if (reason) check.reason = reason;
  return check;
}

function clampTimeout(value) {
  if (!Number.isInteger(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(10000, Math.max(100, value));
}
