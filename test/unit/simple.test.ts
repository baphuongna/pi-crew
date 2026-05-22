import test from 'node:test';
import assert from 'node:assert/strict';

test('simple math', () => {
  assert.equal(1 + 1, 2);
});

test('simple string', () => {
  assert.ok('hello'.includes('ell'));
});
