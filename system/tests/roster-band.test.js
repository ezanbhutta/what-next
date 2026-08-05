import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftBand } from '../lib/roster.js';

test('shiftBand names a shift, never a clock', () => {
  assert.equal(shiftBand(9), 'Morning');
  assert.equal(shiftBand(16), 'Morning');
  assert.equal(shiftBand(17), 'Evening');
  assert.equal(shiftBand(20), 'Evening');
  assert.equal(shiftBand(21), 'Night');
  assert.equal(shiftBand(3), 'Night');
  assert.equal(shiftBand(8), 'Night');
  // Every hour of the day lands in exactly one band.
  const names = new Set();
  for (let h = 0; h < 24; h += 1) {
    const b = shiftBand(h);
    assert.ok(['Morning','Evening','Night'].includes(b), `hour ${h} gave ${b}`);
    names.add(b);
  }
  assert.equal(names.size, 3, 'all three bands are reachable');
  assert.equal(shiftBand(null), null);
  assert.equal(shiftBand('x'), null);
});
