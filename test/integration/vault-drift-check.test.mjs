import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareLiveHeaders, probesForSite, stripFrameAncestors } from './vault-drift-check.mjs';

function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'vault-drift-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'node_modules/@ai-ecoverse/slicc-vault');
  mkdirSync(join(pkg, 'dist/site/fonts'), { recursive: true });
  writeFileSync(join(pkg, 'dist/site/fonts/AdobeClean-Regular.woff2'), '');
  writeFileSync(join(pkg, 'dist/site/frame.js'), '');
  const headers = {
    'content-security-policy': "default-src 'none'; frame-ancestors https://seven.sliccy.ai",
    'cross-origin-resource-policy': 'same-site',
    'content-type': 'text/html; charset=utf-8',
    'x-future-header': 'must-be-served',
  };
  writeFileSync(
    join(pkg, 'dist/headers.json'),
    `${JSON.stringify({
      classes: {
        documents: { headers },
        scripts: {
          headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' },
        },
        fonts: { headers: { ...headers, 'content-type': 'font/woff2' } },
      },
    })}\n`
  );
  return root;
}

function liveHeaders(url, { omitFuture = false, csp } = {}) {
  return {
    get(name) {
      if (name === 'content-security-policy')
        return csp ?? "default-src 'none'; frame-ancestors https://other.example";
      if (name === 'cross-origin-resource-policy') return 'same-site';
      if (name === 'content-type') {
        if (String(url).includes('frame.js')) return 'text/javascript; charset=utf-8';
        if (String(url).includes('woff2')) return 'font/woff2';
        return 'text/html; charset=utf-8';
      }
      if (name === 'x-future-header') return omitFuture ? null : 'must-be-served';
      return null;
    },
  };
}

test('vault drift strips only frame-ancestors when comparing CSP', () => {
  assert.equal(
    stripFrameAncestors(
      "default-src 'none'; frame-ancestors https://a.example https://b.example; base-uri 'none'"
    ),
    "default-src 'none'; frame-ancestors <dynamic>; base-uri 'none'"
  );
});

test('vault drift probes / frame.js a font and any packaged wasm', (t) => {
  const site = mkdtempSync(join(tmpdir(), 'vault-drift-site-'));
  t.after(() => rmSync(site, { recursive: true, force: true }));
  mkdirSync(join(site, 'fonts'), { recursive: true });
  mkdirSync(join(site, 'chunks'), { recursive: true });
  writeFileSync(join(site, 'fonts/AdobeClean-Regular.woff2'), '');
  writeFileSync(join(site, 'frame.js'), '');
  writeFileSync(join(site, 'chunks/module.wasm'), '');
  assert.deepEqual(probesForSite(site), [
    ['/', 'documents'],
    ['/frame.js', 'scripts'],
    ['/fonts/AdobeClean-Regular.woff2', 'fonts'],
    ['/chunks/module.wasm', 'wasm'],
  ]);
});

test('vault drift compares every class header key from headers.json against live', async (t) => {
  const root = fixtureRoot(t);
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(url).pathname);
    return {
      ok: true,
      headers: {
        get(name) {
          if (name === 'content-security-policy')
            return "default-src 'none'; frame-ancestors https://other.example";
          if (name === 'cross-origin-resource-policy') return 'same-site';
          if (name === 'content-type') {
            if (String(url).includes('frame.js')) return 'text/javascript; charset=utf-8';
            if (String(url).includes('woff2')) return 'font/woff2';
            return 'text/html; charset=utf-8';
          }
          if (name === 'x-future-header') return 'must-be-served';
          return null;
        },
      },
    };
  };
  const { diffs, probes } = await compareLiveHeaders({ root, fetchImpl });
  assert.deepEqual(
    probes.map(([path]) => path),
    ['/', '/frame.js', '/fonts/AdobeClean-Regular.woff2']
  );
  assert.deepEqual(seen, ['/', '/frame.js', '/fonts/AdobeClean-Regular.woff2']);
  assert.deepEqual(diffs, []);
});

test('vault drift reports a missing class header and a CSP directive change other than frame-ancestors', async (t) => {
  const root = fixtureRoot(t);
  const missing = await compareLiveHeaders({
    root,
    fetchImpl: async (url) => ({ ok: true, headers: liveHeaders(url, { omitFuture: true }) }),
  });
  assert.deepEqual(missing.diffs, [
    '/: missing x-future-header',
    '/frame.js: missing x-future-header',
    '/fonts/AdobeClean-Regular.woff2: missing x-future-header',
  ]);

  const wantCsp = "default-src 'none'; frame-ancestors https://seven.sliccy.ai";
  const gotCsp =
    "default-src 'none'; script-src 'unsafe-eval'; frame-ancestors https://other.example";
  const changed = await compareLiveHeaders({
    root,
    fetchImpl: async (url) => ({
      ok: true,
      headers: liveHeaders(url, { csp: gotCsp }),
    }),
  });
  assert.deepEqual(changed.diffs, [
    `/: content-security-policy: live ${JSON.stringify(gotCsp)} != pin ${JSON.stringify(wantCsp)}`,
    `/frame.js: content-security-policy: live ${JSON.stringify(gotCsp)} != pin ${JSON.stringify(wantCsp)}`,
    `/fonts/AdobeClean-Regular.woff2: content-security-policy: live ${JSON.stringify(gotCsp)} != pin ${JSON.stringify(wantCsp)}`,
  ]);
});
