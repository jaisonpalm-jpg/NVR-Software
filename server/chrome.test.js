import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('shell chrome uses charcoal panels and an electric-blue primary accent', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const primary = html.match(/\.btn-primary \{[^}]+\}/);
  assert.ok(primary, 'primary button rule');
  assert.match(primary[0], /background:\s*var\(--blue\)/);
  assert.match(primary[0], /color:\s*#f7f9ff/);
  assert.equal(primary[0].includes('--green'), false);
  assert.equal(primary[0].includes('#29d17d'), false);
  assert.equal(primary[0].includes('#041018'), false);
  assert.equal(html.includes('linear-gradient(135deg, var(--green), var(--blue))'), false);
  assert.match(html, /--blue:\s*#2f6bff/);
  assert.match(html, /--bg:\s*#10161f/);
  assert.match(html, /--panel:\s*#0d121b/);
  assert.equal(/background:\s*#000(?:000)?\b/.test(html), false);
  assert.equal(html.includes('#05070c'), false);
  assert.match(html, /button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.match(html, /input:focus-visible,\s*select:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--blue\)/);
  assert.match(html, /\.nav-btn\.active \{[^}]*background:\s*var\(--blue\)/);
  assert.match(html, /\.layout-select button\.active \{[^}]*background:\s*var\(--blue\)/);
  assert.match(html, /\.site-card\.active \{[^}]*rgba\(47,107,255/);
  assert.match(html, /class="setup-grid wizard-steps"/);
  assert.match(html, /\.wizard-steps > \.card \.card-title::before \{[^}]*background:\s*var\(--blue\)/);
  assert.equal((html.match(/class="btn btn-primary"/g) || []).length, 9);
  assert.equal((html.match(/\+ Add Camera/g) || []).length, 2);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(html), false);
});
