import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber } from '../src/repository.js';

test('live lead phones normalize provider formatting before E.164 validation', () => {
  assert.equal(normalizePhoneNumber('+234 909 148 1560'), '+2349091481560');
  assert.equal(normalizePhoneNumber('+234 (909) 148-1560'), '+2349091481560');
  assert.equal(normalizePhoneNumber('+1 (415) 555-2671'), '+14155552671');
  assert.equal(normalizePhoneNumber('0803 123 4567'), null);
  assert.equal(normalizePhoneNumber('+234 90'), null);
  assert.equal(normalizePhoneNumber('not a number'), null);
  assert.equal(normalizePhoneNumber(null), null);
  assert.equal(normalizePhoneNumber(undefined), null);
});
