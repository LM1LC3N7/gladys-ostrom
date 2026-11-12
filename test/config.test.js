import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

test('config: both credentials needed; control characters, spaces inside, unknown environment refused', () => {
  assert.equal(normalizeConfig({}).problem, 'missing');
  assert.equal(normalizeConfig({ client_id: 'abcd' }).problem, 'half');
  assert.equal(normalizeConfig({ client_secret: 'abcd' }).problem, 'half');
  assert.equal(normalizeConfig({ client_id: 'ab\ncd', client_secret: 'x' }).problem, 'malformed');
  assert.equal(normalizeConfig({ client_id: 'ab cd', client_secret: 'x' }).problem, 'malformed');
  assert.equal(
    normalizeConfig({ client_id: 'a', client_secret: 'x', environment: 'dev' }).problem,
    'malformed',
  );
  const ok = normalizeConfig({ client_id: ' abc ', client_secret: 'sec', environment: 'sandbox' });
  assert.deepEqual(ok, {
    clientId: 'abc',
    clientSecret: 'sec',
    environment: 'sandbox',
    problem: undefined,
  });
  assert.equal(normalizeConfig({ client_id: 'a', client_secret: 'b' }).environment, 'production');
});
