// -----------------------------------------------------------------------------
// The session: the token (client credentials), its renewal, what is a refusal
// and what is not, one request at a time, bounded answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OstromError, OstromSession, retryAfterMs, tokenLife } from '../src/ostrom/client.js';
import { createOstrom, json } from './helpers/app.js';
import * as O from './fixtures/ostrom.js';

const CREDS = { clientId: O.CLIENT_ID, clientSecret: O.CLIENT_SECRET, environment: 'production' };

function session(ostrom, { clock = { now: 0 }, gap = 0 } = {}) {
  return new OstromSession({
    credentials: CREDS,
    fetchImpl: ostrom.fetch,
    monotonic: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    gap,
  });
}

const rejects = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof OstromError && err.code === code);

test('Retry-After: seconds or a date against the Date header, never the local clock', () => {
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(
    retryAfterMs('Wed, 11 Nov 2026 10:05:00 GMT', 'Wed, 11 Nov 2026 10:00:00 GMT'),
    300_000,
  );
  assert.equal(retryAfterMs('Wed, 11 Nov 2026 10:05:00 GMT'), undefined);
  assert.equal(retryAfterMs(''), undefined);
});

test('token life: expires_in within bounds, a default otherwise', () => {
  assert.equal(tokenLife(3599), 3_599_000);
  assert.equal(tokenLife(10), 30 * 60_000);
  assert.equal(tokenLife('3599'), 30 * 60_000);
});

test('the token is reused, renewed 5 minutes before its end', async () => {
  const clock = { now: 0 };
  const ostrom = createOstrom();
  const s = session(ostrom, { clock });
  await s.get('/contracts');
  await s.get('/contracts');
  assert.equal(ostrom.count('token'), 1);
  clock.now += 3599_000 - 5 * 60_000 - 1000;
  await s.get('/contracts');
  assert.equal(ostrom.count('token'), 1);
  clock.now += 2000;
  await s.get('/contracts');
  assert.equal(ostrom.count('token'), 2);
});

test('refusal: only a readable invalid_client / unauthorized_client of 400/401', async () => {
  for (const [answer, code] of [
    [() => json({ error: 'invalid_client' }, 401), 'refused'],
    [() => json({ error: 'unauthorized_client' }, 400), 'refused'],
    [() => json({ error: 'invalid_client' }, 403), 'login_failed'],
    [() => json({ error: 'invalid_request' }, 400), 'login_failed'],
    [() => new Response('<html>', { status: 401 }), 'login_failed'],
    [() => json({ error: 'invalid_client' }, 503), 'server'],
    [() => json({}, 429, { 'retry-after': '60' }), 'rate_limited'],
    [() => json({ access_token: 'short' }), 'bad_response'],
    [() => json({ access_token: 'x'.repeat(40), token_type: 'MAC' }), 'bad_response'],
    [() => 'network', 'network'],
  ]) {
    await rejects(session(createOstrom({ token: answer })).get('/contracts'), code);
  }
});

test('an API 401: one new token, one new try; a 403: no new token', async () => {
  let n = 0;
  const ostrom = createOstrom({
    contracts: () => (n++ === 0 ? json({}, 401) : O.contracts()),
  });
  const body = await session(ostrom).get('/contracts');
  assert.equal(body.data.length, 1);
  assert.equal(ostrom.count('token'), 2);
  const forbidden = createOstrom({ contracts: () => json({}, 403) });
  await rejects(session(forbidden).get('/contracts'), 'unauthorized');
  assert.equal(forbidden.count('token'), 1);
});

test('one request at a time, REQUEST_GAP apart from the end of the previous one', async () => {
  const clock = { now: 0 };
  let inFlight = 0;
  let peak = 0;
  const ostrom = createOstrom({
    contracts: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return O.contracts();
    },
  });
  const s = session(ostrom, { clock, gap: 2000 });
  await Promise.all([s.get('/contracts'), s.get('/contracts'), s.get('/contracts')]);
  assert.equal(peak, 1);
  const at = ostrom.calls.map((c) => c.op);
  assert.deepEqual(at, ['token', 'contracts', 'contracts', 'contracts']);
  assert.equal(clock.now, 6000);
});

test('a body too large is refused before being read whole; a declared length is enough', async () => {
  const big = createOstrom({
    contracts: () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }),
  });
  await rejects(session(big).get('/contracts'), 'too_large');
});

test('close(): the request in flight is aborted, nothing more sent', async () => {
  const ostrom = createOstrom({
    contracts: (call) =>
      new Promise((_, reject) =>
        call.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))),
      ),
  });
  const s = session(ostrom);
  const pending = s.get('/contracts');
  await new Promise((r) => setImmediate(r));
  s.close();
  await rejects(pending, 'stopped');
  await rejects(s.get('/contracts'), 'stopped');
  assert.equal(ostrom.count('contracts'), 1);
});

test('no secret in an error message', async () => {
  const ostrom = createOstrom({
    token: () => json({ error: 'invalid_client', error_description: O.CLIENT_SECRET }, 401),
  });
  await assert.rejects(session(ostrom).get('/contracts'), (err) => {
    assert.ok(!String(err.message).includes(O.CLIENT_SECRET));
    assert.ok(!String(err.message).includes(O.CLIENT_ID));
    return true;
  });
});
