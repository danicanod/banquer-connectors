import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getBlockedDomains,
  isEssentialJS,
  BLOCKED_DOMAINS,
  PERFORMANCE_PRESETS,
} from '../src/shared/performance-config.js';

// getBlockedDomains — locks the corrected behaviour (was a broken substring filter).
test('getBlockedDomains: returns nothing when neither ads nor analytics blocking is on', () => {
  assert.deepEqual(getBlockedDomains({}), []);
  assert.deepEqual(getBlockedDomains({ blockCSS: true }), []);
});

test('getBlockedDomains: returns the full curated list when EITHER flag is set', () => {
  assert.equal(getBlockedDomains({ blockAds: true }).length, BLOCKED_DOMAINS.length);
  assert.equal(getBlockedDomains({ blockAnalytics: true }).length, BLOCKED_DOMAINS.length);
  assert.equal(getBlockedDomains({ blockAds: true, blockAnalytics: true }).length, BLOCKED_DOMAINS.length);
});

test('getBlockedDomains: includes trackers a naive substring filter used to drop', () => {
  const blocked = getBlockedDomains({ blockAnalytics: true });
  // facebook.com / hotjar.com contain neither "analytics" nor "ads".
  assert.ok(blocked.includes('facebook.com'));
  assert.ok(blocked.includes('hotjar.com'));
});

test('getBlockedDomains: MAXIMUM preset blocks the whole list', () => {
  assert.equal(getBlockedDomains(PERFORMANCE_PRESETS.MAXIMUM).length, BLOCKED_DOMAINS.length);
});

// isEssentialJS — assert only the stable invariants (Phase 5 may tighten the
// broad pattern list, but same-origin bank JS must always stay allowed).
test('isEssentialJS: same-origin bank scripts are always essential', () => {
  assert.equal(isEssentialJS('https://www.banesco.com/js/app.js', 'banesco'), true);
  assert.equal(isEssentialJS('https://bnc.com.ve/main.js', 'bnc'), true);
});

test('isEssentialJS: a clearly unrelated third-party host is not essential', () => {
  assert.equal(isEssentialJS('https://cdn.unrelated-widget.io/w.js', 'banesco'), false);
});
