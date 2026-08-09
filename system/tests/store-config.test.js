// tests/store-config.test.js, the wiring check that did not exist.
//
// WHY THIS FILE EXISTS
//
// On 2026-08-08 /feeds showed CSR Shift Logger and Impressions board both
// UNREACHABLE. Neither Supabase project was down: both answered an
// unauthenticated probe in about half a second and the reports anon key was
// valid until 2036. The hub had no keys, because README's deploy runbook named
// seven environment variables while the code read nine.
//
// There was no surface anywhere that could have said so. `storeHealth` needs a
// working key to report anything, so with the key absent it returns the same
// "unreachable" as a dead project. `storeConfig` answers the question one level
// down, from the environment alone, and this file pins the four ways it has to
// be able to fail.
//
// STORES captures process.env at module load, so setting a variable in a test
// would change nothing. These mutate the exported object and restore it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { STORES, storeConfig } from '../lib/external.js';

/** A structurally real anon key. Signature is never checked here or anywhere. */
const anonKey = (claims) =>
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  Buffer.from(JSON.stringify({ iss: 'supabase', role: 'anon', ...claims })).toString('base64url') +
  '.notarealsignature';

const REPORTS_REF = 'aeytsgipuuyjlbvebhez';
const IMPRESSIONS_REF = 'jkigyrnvlfcwloqtrycu';
const FAR_FUTURE = 2096961573; // 2036, the real key's own expiry
const LONG_PAST = 1600000000; // 2020

/** Run `fn` with the two store keys forced, then put the originals back. */
function withKeys(reports, impressions, fn) {
  const before = { r: STORES.reports.key, i: STORES.impressions.key };
  STORES.reports.key = reports;
  STORES.impressions.key = impressions;
  try {
    return fn();
  } finally {
    STORES.reports.key = before.r;
    STORES.impressions.key = before.i;
  }
}

test('a missing key is reported as unconfigured, and names the variable to set', () => {
  withKeys('', '', () => {
    const cfg = storeConfig();
    assert.equal(cfg.reports.configured, false);
    assert.equal(cfg.reports.key_format, 'absent');
    assert.match(cfg.reports.notice, /REPORTS_SUPABASE_KEY/);
    assert.match(cfg.impressions.notice, /IMPRESSIONS_SUPABASE_KEY/);
  });
});

test('the missing-key notice warns about the spelling, because a typo looks identical', () => {
  // A misspelled variable name reads as undefined, so it produces exactly the
  // absent case. Somebody staring at a panel row that LOOKS right needs telling.
  withKeys('', '', () => {
    assert.match(storeConfig().reports.notice, /spelling/i);
  });
});

test('a correct key matches the project its URL points at', () => {
  withKeys(
    anonKey({ ref: REPORTS_REF, exp: FAR_FUTURE }),
    anonKey({ ref: IMPRESSIONS_REF, exp: FAR_FUTURE }),
    () => {
      const cfg = storeConfig();
      for (const row of Object.values(cfg)) {
        assert.equal(row.configured, true);
        assert.equal(row.key_format, 'legacy_jwt');
        assert.equal(row.key_matches_url, true);
        assert.equal(row.expired, false);
        assert.equal(row.notice, null);
      }
    }
  );
});

test('SWAPPED keys are caught, which is the failure that looks like every other one', () => {
  // Both keys are 208 characters and both begin eyJhbGci. Swapped, they yield
  // two 401s that render on /feeds exactly like the keys being absent. `ref` is
  // the only thing in the value that can tell them apart.
  withKeys(
    anonKey({ ref: IMPRESSIONS_REF, exp: FAR_FUTURE }), // in the reports slot
    anonKey({ ref: REPORTS_REF, exp: FAR_FUTURE }), // in the impressions slot
    () => {
      const cfg = storeConfig();
      assert.equal(cfg.reports.key_matches_url, false);
      assert.equal(cfg.impressions.key_matches_url, false);
      assert.match(cfg.reports.notice, /swapped/i);
      assert.equal(cfg.reports.key_project, IMPRESSIONS_REF);
      assert.equal(cfg.reports.url_project, REPORTS_REF);
    }
  );
});

test('an expired key is reported as expired rather than merely present', () => {
  withKeys(
    anonKey({ ref: REPORTS_REF, exp: LONG_PAST }),
    anonKey({ ref: IMPRESSIONS_REF, exp: FAR_FUTURE }),
    () => {
      const cfg = storeConfig();
      assert.equal(cfg.reports.expired, true);
      assert.match(cfg.reports.notice, /expired/i);
      assert.equal(cfg.impressions.expired, false);
    }
  );
});

test('a publishable key is recognised rather than called malformed', () => {
  withKeys('sb_publishable_abc123', 'sb_publishable_def456', () => {
    const cfg = storeConfig();
    assert.equal(cfg.reports.key_format, 'publishable');
    assert.equal(cfg.reports.configured, true);
    assert.equal(cfg.reports.notice, null);
  });
});

test('a value that is neither shape is called unrecognised, not silently accepted', () => {
  withKeys('paste-gone-wrong', 'eyJhbGci.not-base64-at-all.sig', () => {
    const cfg = storeConfig();
    assert.equal(cfg.reports.key_format, 'unrecognised');
    assert.equal(cfg.impressions.key_format, 'unrecognised');
    assert.ok(cfg.reports.notice);
  });
});

test('the key value itself never appears in the output', () => {
  // The whole point is that this is safe to serve unauthenticated. If a future
  // edit ever puts the secret in a field "just for debugging", fail here.
  const secret = anonKey({ ref: REPORTS_REF, exp: FAR_FUTURE });
  withKeys(secret, secret, () => {
    const serialised = JSON.stringify(storeConfig());
    assert.ok(!serialised.includes(secret), 'storeConfig leaked the key value');
    // The signature segment is the part that is genuinely secret-shaped.
    assert.ok(!serialised.includes('notarealsignature'));
  });
});
