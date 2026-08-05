// tests/shared-device.test.js
//
// Four people share one laptop. The properties below are the ones that make
// that safe, and every one of them was broken before the device cookie stopped
// carrying a name.

import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-secret-that-is-long-enough-to-sign-with';
process.env.APP_PASSWORD ||= 'Xstudioz2026';

const {
  verifyDeviceToken,
  rememberDevice,
  verifySessionToken,
  startSession,
  SHIFT_TTL_MS,
  DEVICE_COOKIE,
  COOKIE_NAME,
} = await import('../lib/auth.js');

/** A res that records what it set, so a cookie can be read back. */
function fakeRes() {
  const jar = new Map();
  return {
    jar,
    cookie: (name, value) => jar.set(name, value),
    clearCookie: (name) => jar.delete(name),
  };
}

test('a shared device is trusted and names nobody', () => {
  const res = fakeRes();
  rememberDevice(res, { shared: true });
  const device = verifyDeviceToken(res.jar.get(DEVICE_COOKIE));

  assert.equal(device.shared, true);
  assert.equal(device.name, null, 'a shared laptop must not carry a person');
  assert.equal(device.role, null, 'and must not carry a role, or it grants one');
});

test('a personal device still names its owner, so nothing regressed', () => {
  const res = fakeRes();
  rememberDevice(res, { name: 'Nadir', role: 'csr' });
  const device = verifyDeviceToken(res.jar.get(DEVICE_COOKIE));
  assert.equal(device.shared, false);
  assert.equal(device.name, 'Nadir');
});

test('a shared device cannot be forged into a personal one by editing the flag', () => {
  // The whole payload is signed, so flipping s:1 to s:0 to smuggle a name in
  // breaks the HMAC rather than producing a device bound to somebody.
  const res = fakeRes();
  rememberDevice(res, { shared: true });
  const token = res.jar.get(DEVICE_COOKIE);
  const [version, body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.s = 0;
  payload.n = 'Ezan';
  payload.r = 'owner';
  const forged = `${version}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
  assert.equal(verifyDeviceToken(forged), null);
});

test('a device that is neither shared nor named is refused, not guessed at', () => {
  // Would otherwise resolve to a session signed by nobody, which is the exact
  // thing the whole attribution design exists to prevent.
  const res = fakeRes();
  rememberDevice(res, { shared: true });
  const [version, body] = res.jar.get(DEVICE_COOKIE).split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.s = 0;
  payload.n = null;
  const newBody = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // Sign it properly, so this tests the rule and not the signature.
  const key = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update('xstudioz:device:v1')
    .digest();
  const sig = crypto.createHmac('sha256', key).update(newBody).digest().toString('base64url');
  assert.equal(verifyDeviceToken(`${version}.${newBody}.${sig}`), null);
});

test('a shift session expires within one shift, not one week', () => {
  const res = fakeRes();
  const started = startSession(res, { name: 'Amrah', role: 'csr', shift: true });
  const hours = (started.expiresAt - Date.now()) / 3_600_000;

  assert.ok(hours <= 14.1, `a shift session lasted ${hours.toFixed(1)}h, it must not outlive a shift`);
  assert.ok(hours > 11, 'and must cover the longest rostered shift, twelve hours');
  assert.equal(SHIFT_TTL_MS, 14 * 60 * 60 * 1000);

  // The flag has to survive the cookie, or attachUser slides it and Amrah
  // stays signed in through Hasnain's whole evening.
  const decoded = verifySessionToken(res.jar.get(COOKIE_NAME));
  assert.equal(decoded.shift, true);
});

test('a normal session is a week, and is not marked as a shift', () => {
  const res = fakeRes();
  const started = startSession(res, { name: 'Nadir', role: 'csr' });
  const days = (started.expiresAt - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days < 7.1, `expected a week, got ${days.toFixed(2)} days`);
  assert.equal(verifySessionToken(res.jar.get(COOKIE_NAME)).shift, false);
});

test('old d1 device cookies stop verifying, so nobody carries a stale binding', () => {
  // The four of them are already enrolled under the old single-name shape. If
  // d1 kept verifying they would keep writing under one name and never see the
  // new picker at all.
  const key = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update('xstudioz:device:v1')
    .digest();
  const body = Buffer.from(
    JSON.stringify({ n: 'Amrah', r: 'csr', d: 'x', e: Date.now() + 86_400_000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest().toString('base64url');
  assert.equal(verifyDeviceToken(`d1.${body}.${sig}`), null);
});
