#!/usr/bin/env node
/**
 * Smoke tests — runs critical module smoke checks without spinning up the
 * full server. Runs in <2 seconds and is safe for CI.
 *
 * Usage:  node scripts/smoke.mjs
 * Exits 0 on success, 1 on any assertion failure.
 */

import { strict as assert } from 'assert';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

console.log('windbu smoke tests\n');

// ── proto.js varint round-trip ──
console.log('[proto]');
const { encodeVarint, decodeVarint } = await import('../src/proto.js');
test('small number round-trip', () => {
  const r = decodeVarint(encodeVarint(150));
  assert.equal(r.value, 150);
});
test('zero round-trip', () => {
  const r = decodeVarint(encodeVarint(0));
  assert.equal(r.value, 0);
});
test('uint32 max round-trip', () => {
  const r = decodeVarint(encodeVarint(4294967295));
  assert.equal(r.value, 4294967295);
});
test('bigint above 2^53 round-trip', () => {
  const big = 9007199254740993n;
  const r = decodeVarint(encodeVarint(big));
  assert.equal(r.value, big);
});

// ── cache.js key differentiation ──
console.log('\n[cache]');
const { cacheKey } = await import('../src/cache.js');
test('reasoning_effort changes key', () => {
  const base = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  assert.notEqual(cacheKey({ ...base, reasoning_effort: 'low' }), cacheKey({ ...base, reasoning_effort: 'max' }));
});
test('fast flag changes key', () => {
  const base = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  assert.notEqual(cacheKey({ ...base, fast: true }), cacheKey({ ...base, fast: false }));
});
test('service_tier changes key', () => {
  const base = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  assert.notEqual(cacheKey({ ...base, service_tier: 'priority' }), cacheKey(base));
});
test('stream flag is ignored', () => {
  const base = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(cacheKey({ ...base, stream: true }), cacheKey({ ...base, stream: false }));
});

// ── conversation-pool checkout preserves on callerKey mismatch ──
console.log('\n[conversation-pool]');
const { checkout, checkin } = await import('../src/conversation-pool.js');
test('cross-caller checkout returns null without evicting', () => {
  const fp = 'smoke-test-fp-' + Date.now();
  checkin(fp, { cascadeId: 'cid', sessionId: 's', lsPort: 1, apiKey: 'k' }, 'owner');
  const cross = checkout(fp, 'intruder');
  assert.equal(cross, null);
  const owner = checkout(fp, 'owner');
  assert.equal(owner?.cascadeId, 'cid');
});

// ── SSRF hostname prefilter ──
console.log('\n[image SSRF]');
const { validateImageUrl } = await import('../src/image.js');
for (const [url, shouldAccept] of [
  ['http://127.0.0.1/a.png', false],
  ['https://localhost/a.png', false],
  ['http://169.254.169.254/a.png', false],
  ['http://10.0.0.5/a.png', false],
  ['http://192.168.1.1/a.png', false],
  ['ftp://example.com/a.png', false],
  ['https://example.com/a.png', true],
]) {
  test(`${url} -> ${shouldAccept ? 'accept' : 'reject'}`, () => {
    let accepted = true;
    try { validateImageUrl(url); } catch { accepted = false; }
    assert.equal(accepted, shouldAccept);
  });
}

// ── sanitize path scrubbing ──
console.log('\n[sanitize]');
const { sanitizeText, PathSanitizeStream } = await import('../src/sanitize.js');
test('tmp path redacted', () => {
  assert.match(sanitizeText('See /tmp/windsurf-workspace/foo'), /\.\/foo/);
});
test('opt path redacted', () => {
  assert.match(sanitizeText('LS at /opt/windsurf/bin'), /\[internal\]/);
});
test('streaming cut-point holds on partial match', () => {
  const s = new PathSanitizeStream();
  const a = s.feed('See /tmp/windsurf-work');
  const b = s.feed('space/foo done');
  const full = a + b + s.flush();
  assert.doesNotMatch(full, /\/tmp\/windsurf-workspace/);
  assert.match(full, /\.\/foo/);
});

// ── setAccountStatus whitelist ──
console.log('\n[auth]');
const { addAccountByKey, setAccountStatus, getAccountList, removeAccount, validateApiKey } = await import('../src/auth.js');
test('setAccountStatus accepts active/disabled/error/expired', () => {
  const a = addAccountByKey('smoke-test-key-1', 'smoke-test');
  assert.equal(setAccountStatus(a.id, 'active'), true);
  assert.equal(setAccountStatus(a.id, 'disabled'), true);
  assert.equal(setAccountStatus(a.id, 'error'), true);
  assert.equal(setAccountStatus(a.id, 'expired'), true);
  assert.equal(setAccountStatus(a.id, 'bogus'), false);
  assert.equal(setAccountStatus(a.id, ''), false);
  assert.equal(setAccountStatus(a.id, null), false);
  removeAccount(a.id);
});
test('validateApiKey is constant-time (no throw on length mismatch)', () => {
  // When config.apiKey is empty, it accepts anything. We just verify it doesn't throw.
  const r = validateApiKey('short');
  assert.equal(typeof r, 'boolean');
});

// ── Summary ──
console.log('');
if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('All smoke tests passed');
process.exit(0);
