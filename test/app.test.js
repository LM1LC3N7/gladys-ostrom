// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Ostrom API and a virtual
// clock: pace, refusal, pauses, /data, Discovery, consumption, prices,
// delegated pricing, secrets.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHandlers } from '../src/handlers.js';
import { createMemoryStore } from '../src/store.js';
import { fromBerlin } from '../src/time.js';
import { keyOf } from '../src/ostrom/model.js';
import { CONFIG, DAY, HOUR, MINUTE, createOstrom, json, setup, written } from './helpers/app.js';
import * as O from './fixtures/ostrom.js';

const statusText = (env) => env.fake.connectionStatus?.message?.en ?? '';
const KEY = keyOf(O.ID_KEY, 'contract', String(O.CONTRACT_ID));
const F = (feature, key = KEY) => `ext:ostrom:contract:${key}:${feature}`;
const QUARTER = 15 * MINUTE;

const deviceOf = (env) =>
  structuredClone(env.fake.discoveredDevices.find((d) => d.external_id.includes(':contract:')));

async function started(options = {}) {
  const env = await setup(options);
  registerHandlers(env.gladys, env.app, env.app.log);
  await env.start(options.config);
  return env;
}

/** Started, then the device created by the user from Discovery. */
async function withDevice(options = {}) {
  const env = await started(options);
  await env.fake.deviceCreated(deviceOf(env));
  return env;
}

const SECRETS = [
  O.CLIENT_SECRET,
  O.CLIENT_ID,
  String(O.CONTRACT_ID),
  O.ZIP,
  'Mustermann',
  'Erika',
  'Musterstraße',
  'tok-',
];

const contract = (inputs = {}) => ({
  id: 'c1',
  template_key: 'ostrom-simply-dynamic',
  inputs,
  currency: 'EUR',
  timezone: 'Europe/Berlin',
  billing_period_start_day: 1,
});

test('start: one token, the contracts and the prices; Discovery, status; nothing secret written out', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  assert.deepEqual(
    env.ostrom.calls.map((c) => c.op),
    ['token', 'contracts', 'prices'],
  );
  const [tokenCall, contractsCall, pricesCall] = env.ostrom.calls;
  assert.equal(tokenCall.url, 'https://auth.production.ostrom-api.io/oauth2/token');
  assert.equal(tokenCall.method, 'POST');
  assert.equal(tokenCall.body, 'grant_type=client_credentials');
  assert.equal(
    tokenCall.auth,
    `Basic ${Buffer.from(`${O.CLIENT_ID}:${O.CLIENT_SECRET}`).toString('base64')}`,
  );
  assert.match(tokenCall.headers['User-Agent'], /^gladys-ostrom\/\d+\.\d+\.\d+ \(\+https:/);
  assert.match(contractsCall.url, /^https:\/\/production\.ostrom-api\.io\/contracts$/);
  assert.match(contractsCall.auth, /^Bearer tok-/);
  assert.equal(pricesCall.query.zip, O.ZIP);
  assert.equal(pricesCall.query.resolution, 'QUARTER_HOUR');
  // Yesterday to the end of tomorrow, German days.
  assert.equal(Date.parse(pricesCall.query.startDate), fromBerlin(2026, 11, 10));
  assert.equal(Date.parse(pricesCall.query.endDate), fromBerlin(2026, 11, 13));
  const [device] = env.fake.discoveredDevices;
  assert.equal(device.name, 'Ostrom electricity (contract …3456)');
  assert.equal(device.external_id, `ext:ostrom:contract:${KEY}`);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['price', 'next_price', 'monthly_fees', 'consumption'],
  );
  assert.match(statusText(env), /^Connected: 1 contract\(s\), read at 11:00\.$/);
  assert.equal(env.fake.connectionStatus.connected, true);
  const out = written(env);
  for (const secret of SECRETS) assert.ok(!out.includes(secret), `${secret} written out`);
  assert.equal(env.store.data.contracts[0].suffix, '3456');
  assert.equal(env.store.data.contracts[0].dynamic, true);
});

test('the sandbox environment sends to the sandbox hosts only', async (t) => {
  const env = await started({ config: { ...CONFIG, environment: 'sandbox' } });
  t.after(() => env.app.stop());
  assert.ok(env.ostrom.calls.length >= 2);
  for (const c of env.ostrom.calls)
    assert.match(c.url, /^https:\/\/(auth\.)?sandbox\.ostrom-api\.io\//);
});

test('prices: kept by quarter, published as features; the next read at 15:00, then hourly until tomorrow', async (t) => {
  // Tomorrow's prices are not there yet.
  const ostrom = createOstrom({
    prices: ({ query }) =>
      O.spotPrices({ from: Date.parse(query.startDate), to: fromBerlin(2026, 11, 12) }),
  });
  const env = await withDevice({ ostrom });
  t.after(() => env.app.stop());
  const q = O.NOW - (O.NOW % QUARTER);
  assert.equal(lastState(env, F('price')), O.priceOf(q));
  assert.equal(lastState(env, F('next_price')), O.priceOf(q + HOUR));
  assert.equal(lastState(env, F('monthly_fees')), 10.57);
  // The prices of today are held: nothing until 15:00 (14:00 UTC), then hourly
  // while tomorrow's are not there.
  await env.wait(4 * HOUR - MINUTE);
  assert.equal(env.ostrom.count('prices'), 1);
  await env.wait(2 * MINUTE);
  assert.equal(env.ostrom.count('prices'), 2);
  await env.wait(HOUR - 2 * MINUTE);
  assert.equal(env.ostrom.count('prices'), 2, 'never sooner than an hour');
  await env.wait(2 * MINUTE);
  assert.equal(env.ostrom.count('prices'), 3);
  // Tomorrow's prices arrive: none asked again before 15:00 tomorrow.
  env.ostrom.answers.prices = ({ query }) =>
    O.spotPrices({ from: Date.parse(query.startDate), to: Date.parse(query.endDate) });
  await env.wait(HOUR);
  assert.equal(env.ostrom.count('prices'), 4);
  await env.wait(20 * HOUR);
  assert.equal(env.ostrom.count('prices'), 4);
  // The price feature follows the quarters (no request).
  const now = env.clock.now;
  assert.equal(lastState(env, F('price')), O.priceOf(now - (now % QUARTER)));
});

function lastState(env, id) {
  const all = env.fake.states.filter((s) => s.device_feature_external_id === id);
  return all.at(-1)?.state;
}

test('pace: the contracts every 6 hours; a restart waits for the rest; Discovery and Save never read', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.fake.scanRequest();
  await env.wait(1000);
  assert.equal(env.ostrom.count('contracts'), 1);
  await env.wait(6 * HOUR - 2000);
  assert.equal(env.ostrom.count('contracts'), 1);
  await env.wait(2000);
  assert.equal(env.ostrom.count('contracts'), 2);
  // One token for both reads? No: the token lives an hour; a new one is obtained.
  assert.equal(env.ostrom.count('token'), 2);
  await env.app.stop();
  const sent = env.ostrom.calls.length;
  await env.wait(DAY);
  assert.equal(env.ostrom.calls.length, sent, 'nothing after stop()');
  // A restart 1 hour later: the next read of the contracts 5 hours after it.
  const later = await started({ store, now: env.clock.now - DAY + HOUR });
  t.after(() => later.app.stop());
  assert.equal(later.ostrom.count('contracts'), 0);
  assert.match(statusText(later), /^Starting: first read at/);
  await later.wait(5 * HOUR - MINUTE);
  assert.equal(later.ostrom.count('contracts'), 0);
  await later.wait(2 * MINUTE);
  assert.equal(later.ostrom.count('contracts'), 1);
});

test('a time of /data in the future is ignored (read at once)', async (t) => {
  const store = createMemoryStore({ lastContracts: O.NOW + DAY });
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(env.ostrom.count('contracts'), 1);
});

test('refusal: invalid_client is kept, nothing sent until new credentials or a successful Test', async (t) => {
  const store = createMemoryStore();
  const ostrom = createOstrom({
    token: () => json({ error: 'invalid_client', error_description: 'bad' }, 401),
  });
  const env = await started({ store, ostrom });
  assert.equal(ostrom.count('token'), 1);
  assert.match(statusText(env), /refused the client id or the client secret \(invalid_client\)/);
  // No round left scheduled while refused.
  assert.equal(env.app.roundTimer, null);
  await env.wait(DAY);
  assert.equal(ostrom.calls.length, 1);
  assert.ok(Number.isInteger(store.data.refused.tag));
  assert.ok(!JSON.stringify(store.data).includes(O.CLIENT_SECRET));
  await env.app.stop();
  // A restart with the same credentials: still nothing sent.
  const again = await started({ store, ostrom, now: env.clock.now });
  await again.wait(DAY);
  assert.equal(ostrom.calls.length, 1);
  // Test: tried (a user click), refused again.
  const refused = await again.fake.action('test_connection');
  assert.match(JSON.stringify(refused), /refused/);
  assert.equal(ostrom.count('token'), 2);
  // New credentials: tried at once.
  ostrom.answers.token = () => O.token();
  await again.fake.configUpdated({ ...CONFIG, client_secret: 'another-secret-value' });
  await again.wait(2 * MINUTE);
  t.after(() => again.app.stop());
  assert.equal(ostrom.count('contracts'), 1);
  assert.equal(store.data.refused, null);
  assert.match(statusText(again), /^Connected/);
});

test('the Test button lifts a refusal on success, at most once a minute', async (t) => {
  const store = createMemoryStore();
  const ostrom = createOstrom({ token: () => json({ error: 'unauthorized_client' }, 400) });
  const env = await started({ store, ostrom });
  t.after(() => env.app.stop());
  assert.ok(store.data.refused);
  ostrom.answers.token = () => O.token();
  const ok = await env.fake.action('test_connection');
  assert.match(JSON.stringify(ok), /Connected to Ostrom: 1 contract/);
  assert.equal(store.data.refused, null);
  const soon = await env.fake.action('test_connection');
  assert.match(JSON.stringify(soon), /one test a minute/);
  await env.wait(2 * MINUTE);
  assert.equal(ostrom.count('contracts'), 2);
});

for (const [name, answer] of [
  ['a 401 without an OAuth2 body', () => new Response('nope', { status: 401 })],
  ['a 403 of the token endpoint', () => json({ error: 'invalid_client' }, 403)],
  ['a 400 invalid_request', () => json({ error: 'invalid_request' }, 400)],
  ['a token cut short', () => new Response('{"access_token":"tok-', { status: 200 })],
]) {
  test(`not a refusal: ${name}; tried again after 5 minutes`, async (t) => {
    const ostrom = createOstrom({ token: answer });
    const env = await started({ ostrom });
    t.after(() => env.app.stop());
    assert.equal(env.app.refused, undefined);
    assert.match(statusText(env), /^Ostrom not read \(/);
    await env.wait(5 * MINUTE + 1000);
    assert.equal(ostrom.count('token'), 2);
  });
}

test('an API 401: one new token and one new try; twice: passing, spaced 5, 10, 20 minutes', async (t) => {
  const ostrom = createOstrom({ contracts: () => json({ type: 'unauthorized' }, 401) });
  const env = await started({ ostrom });
  t.after(() => env.app.stop());
  assert.deepEqual(
    ostrom.calls.map((c) => c.op),
    ['token', 'contracts', 'token', 'contracts'],
  );
  assert.equal(env.app.refused, undefined);
  assert.match(statusText(env), /Ostrom not read \(unauthorized 401\)/);
  await env.wait(5 * MINUTE + 1000);
  assert.equal(ostrom.count('contracts'), 4);
  await env.wait(10 * MINUTE - 2000);
  assert.equal(ostrom.count('contracts'), 4);
  await env.wait(2000);
  assert.equal(ostrom.count('contracts'), 6);
});

test('a 403 of the prices never stops the contracts nor counts as a refusal', async (t) => {
  const ostrom = createOstrom({ prices: () => json({ type: 'forbidden' }, 403) });
  const env = await withDevice({ ostrom });
  t.after(() => env.app.stop());
  assert.equal(env.app.refused, undefined);
  assert.match(statusText(env), /^Connected: 1 contract.*Prices not read \(unauthorized 403\)/);
  assert.equal(env.fake.connectionStatus.connected, true);
  // The consumption is still read.
  await env.wait(2 * MINUTE);
  assert.equal(ostrom.count('consumption'), 1);
});

test('429: paused as long as asked (persisted), the Retry-After kept across a restart', async (t) => {
  const store = createMemoryStore();
  const ostrom = createOstrom({
    contracts: () => json({ type: 'too_many' }, 429, { 'retry-after': '7200' }),
  });
  const env = await started({ store, ostrom });
  assert.match(statusText(env), /asked to slow down \(HTTP 429\): no request until 13:00/);
  assert.equal(store.data.pause.code, 'rate_limited');
  const test1 = await env.fake.action('test_connection');
  assert.match(JSON.stringify(test1), /Not sent/);
  await env.app.stop();
  ostrom.answers.contracts = () => O.contracts();
  const later = await started({ store, ostrom, now: O.NOW + HOUR });
  t.after(() => later.app.stop());
  await later.wait(HOUR - MINUTE);
  assert.equal(ostrom.count('contracts'), 1);
  await later.wait(2 * MINUTE);
  assert.equal(ostrom.count('contracts'), 2);
  assert.equal(store.data.pause, null);
});

test('5xx: paused 5 minutes, doubled', async (t) => {
  const ostrom = createOstrom({ contracts: () => json({}, 503) });
  const env = await started({ ostrom });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /unavailable \(HTTP 503\)/);
  await env.wait(5 * MINUTE + 1000);
  assert.equal(ostrom.count('contracts'), 2);
  await env.wait(10 * MINUTE - 2000);
  assert.equal(ostrom.count('contracts'), 2);
  await env.wait(2000);
  assert.equal(ostrom.count('contracts'), 3);
});

test('an answer too large is cut, never read whole', async (t) => {
  let pulled = 0;
  const huge = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(256 * 1024).fill(32));
          if (pulled > 100) controller.close();
        },
      }),
      { status: 200 },
    );
  const ostrom = createOstrom({ contracts: huge });
  const env = await started({ ostrom });
  t.after(() => env.app.stop());
  assert.match(statusText(env), /too_large/);
  assert.ok(pulled <= 10, `${pulled} chunks read`);
});

test('consumption: a new device gets 7 days in half hours; then 3 days every 3 hours', async (t) => {
  const env = await withDevice();
  t.after(() => env.app.stop());
  await env.wait(2 * MINUTE);
  assert.equal(env.ostrom.count('consumption'), 1);
  const call = env.ostrom.calls.find((c) => c.op === 'consumption');
  assert.equal(call.path, `/contracts/${O.CONTRACT_ID}/energy-consumption`);
  assert.equal(call.query.resolution, 'HOUR');
  assert.equal(Date.parse(call.query.startDate), fromBerlin(2026, 11, 4));
  const [batch] = env.fake.publishedEnergyConsumption;
  assert.equal(batch.device_feature_external_id, F('consumption'));
  assert.equal(batch.intervals[0].kwh, O.KWH / 2);
  assert.equal(batch.intervals.length % 2, 0);
  // Only ended hours: the last interval ends at or before now.
  const last = Date.parse(batch.intervals.at(-1).starts_at) + 30 * MINUTE;
  assert.ok(last <= env.clock.now);
  await env.wait(3 * HOUR);
  assert.equal(env.ostrom.count('consumption'), 2);
  const second = env.ostrom.calls.filter((c) => c.op === 'consumption')[1];
  assert.equal(Date.parse(second.query.startDate), fromBerlin(2026, 11, 8));
});

test('consumption: a value unreadable is left out, never 0; a 404 does not stop the prices', async (t) => {
  const ostrom = createOstrom({
    consumption: ({ query }, now) => {
      const body = O.consumption({
        from: Date.parse(query.startDate),
        to: now - (now % HOUR),
      });
      body.data[0].kWh = null;
      body.data[1].kWh = 'x';
      body.data[2].kWh = -1;
      return body;
    },
  });
  const env = await withDevice({ ostrom });
  t.after(() => env.app.stop());
  await env.wait(2 * MINUTE);
  const [batch] = env.fake.publishedEnergyConsumption;
  assert.ok(batch.intervals.every((i) => i.kwh === O.KWH / 2));
  assert.equal(Date.parse(batch.intervals[0].starts_at), fromBerlin(2026, 11, 4) + 3 * HOUR);
  ostrom.answers.consumption = () => json({ type: 'not_found' }, 404);
  await env.wait(3 * HOUR);
  assert.match(statusText(env), /Consumption not read \(not_found 404\)/);
  assert.equal(env.fake.connectionStatus.connected, true);
});

test('delegated pricing: each half hour at the mean of its two quarters, a negative price costs 0', async (t) => {
  // 05:xx UTC all negative; every :15 negative.
  const spot = (q) =>
    new Date(q).getUTCHours() === 5
      ? -60
      : new Date(q).getUTCMinutes() === 15
        ? -40
        : 10 + new Date(q).getUTCHours();
  const ostrom = createOstrom({
    prices: ({ query }) =>
      O.spotPrices({ from: Date.parse(query.startDate), to: Date.parse(query.endDate), spot }),
  });
  const env = await started({ ostrom });
  t.after(() => env.app.stop());
  const t0 = fromBerlin(2026, 11, 10, 8);
  const ack = await env.fake.energyPrice({
    contract: contract(),
    billing_period: {},
    cumulative_before: {},
    intervals: [
      { starts_at: new Date(t0).toISOString(), kwh: 2, max_power_kw: 1 },
      { starts_at: new Date(t0 + 30 * MINUTE).toISOString(), kwh: 2, max_power_kw: 1 },
    ],
  });
  assert.equal(ack.success, true, JSON.stringify(ack));
  const [a, b] = ack.data.costs;
  const p = (q) => (spot(q) + O.TAXES) / 100;
  // 08:00 + 08:15 (negative -> mean of 0.2628 and -0.2072).
  assert.equal(a.cost, Math.round(Math.max(0, (2 * (p(t0) + p(t0 + QUARTER))) / 2) * 1e8) / 1e8);
  assert.ok(Math.abs(b.cost - 2 * p(t0 + 30 * MINUTE)) < 1e-6);
  const negative = await env.fake.energyPrice({
    contract: contract(),
    billing_period: {},
    cumulative_before: {},
    intervals: [
      { starts_at: new Date(fromBerlin(2026, 11, 10, 6)).toISOString(), kwh: 1, max_power_kw: 1 },
    ],
  });
  assert.equal(negative.success, true, JSON.stringify(negative));
  assert.equal(negative.data.costs[0].cost, 0);
  // Before the prices held: no cost (never a silent zero).
  const missing = await env.fake.energyPrice({
    contract: contract(),
    billing_period: {},
    cumulative_before: {},
    intervals: [{ starts_at: new Date(t0 - 2 * DAY).toISOString(), kwh: 1, max_power_kw: 1 }],
  });
  assert.equal(missing.success, false);
  // An unknown contract suffix: never a guess.
  const other = await env.fake.energyPrice({
    contract: contract({ contract_suffix: '9999' }),
    billing_period: {},
    cumulative_before: {},
    intervals: [{ starts_at: new Date(t0).toISOString(), kwh: 1, max_power_kw: 1 }],
  });
  assert.equal(other.success, false);
  const right = await env.fake.energyPrice({
    contract: contract({ contract_suffix: '456' }),
    billing_period: {},
    cumulative_before: {},
    intervals: [{ starts_at: new Date(t0 + HOUR).toISOString(), kwh: 1, max_power_kw: 1 }],
  });
  assert.equal(right.success, true);
});

test('delegated pricing answers from /data after a restart, without any request', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  await env.app.stop();
  const ostrom = createOstrom({ token: () => 'network' });
  const later = await started({ store, ostrom, now: O.NOW + 10 * MINUTE });
  t.after(() => later.app.stop());
  const t0 = fromBerlin(2026, 11, 11, 9);
  const ack = await later.fake.energyPrice({
    contract: contract(),
    billing_period: {},
    cumulative_before: {},
    intervals: [{ starts_at: new Date(t0).toISOString(), kwh: 1, max_power_kw: 1 }],
  });
  assert.equal(ack.success, true);
  assert.ok(Math.abs(ack.data.costs[0].cost - O.priceOf(t0)) < 1e-9);
  const current = await later.fake.energyCurrent({ contract: contract(), cumulative: {} });
  assert.equal(current.success, true);
  const now = later.clock.now;
  assert.equal(current.data.price, O.priceOf(now - (now % QUARTER)));
  assert.equal(current.data.next_price, O.priceOf(now - (now % HOUR) + HOUR));
  assert.equal(Date.parse(current.data.valid_until), now - (now % HOUR) + HOUR);
});

test('a fixed-price contract has no price feature and is never priced', async (t) => {
  const ostrom = createOstrom({
    contracts: () => O.contracts([O.contract({ productCode: 'SIMPLY_FAIR' })]),
  });
  const env = await started({ ostrom });
  t.after(() => env.app.stop());
  assert.equal(ostrom.count('prices'), 0);
  const device = deviceOf(env);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ['consumption'],
  );
  const ack = await env.fake.energyPrice({
    contract: contract(),
    billing_period: {},
    cumulative_before: {},
    intervals: [{ starts_at: new Date(O.NOW - HOUR).toISOString(), kwh: 1, max_power_kw: 1 }],
  });
  assert.equal(ack.success, false);
  const current = await env.fake.energyCurrent({ contract: contract(), cumulative: {} });
  assert.equal(current.data.price, null);
});

test('a postcode Ostrom gives no taxes for: its prices are never kept; asked again after 6 hours', async (t) => {
  const ostrom = createOstrom({
    prices: ({ query }) =>
      O.spotPrices({
        from: Date.parse(query.startDate),
        to: Date.parse(query.endDate),
        zip: false,
      }),
  });
  const env = await withDevice({ ostrom });
  t.after(() => env.app.stop());
  assert.deepEqual(env.store.data.prices[KEY] ?? {}, {});
  assert.equal(lastState(env, F('price')), undefined);
  assert.match(statusText(env), /no taxes nor grid fees for the postcode/);
  await env.wait(6 * HOUR - 2 * MINUTE);
  assert.equal(ostrom.count('prices'), 1);
  await env.wait(4 * MINUTE);
  assert.equal(ostrom.count('prices'), 2);
});

test('a contract without a postcode: its prices are not asked', async (t) => {
  const ostrom = createOstrom({
    contracts: () => O.contracts([O.contract({ address: { city: 'Berlin' } })]),
  });
  const env = await started({ ostrom });
  t.after(() => env.app.stop());
  assert.equal(ostrom.count('prices'), 0);
  assert.match(statusText(env), /no readable postcode/);
});

test('/data unreadable: never overwritten, read again, then used', async (t) => {
  const store = createMemoryStore({ lastContracts: O.NOW - HOUR, version: 1 });
  store.unreadable = true;
  const env = await started({ store });
  t.after(() => env.app.stop());
  assert.equal(store.saves, 0);
  assert.match(statusText(env), /\/data cannot be read/);
  // Unknown last read: a whole interval waited, never a read at once.
  assert.equal(env.ostrom.count('contracts'), 0);
  store.unreadable = false;
  await env.wait(11 * 1000);
  assert.ok(store.loads >= 2);
  assert.ok(store.saves >= 1);
  assert.doesNotMatch(statusText(env), /\/data/);
  // The last read of /data (an hour ago) counts: the contracts 5 hours later.
  await env.wait(5 * HOUR - MINUTE);
  assert.equal(env.ostrom.count('contracts'), 0);
  await env.wait(2 * MINUTE);
  assert.equal(env.ostrom.count('contracts'), 1);
});

test('getConfig failing in connected: retried, spaced, then the integration starts', async (t) => {
  const env = await setup();
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  const real = env.gladys.getConfig.bind(env.gladys);
  let fails = 2;
  env.gladys.getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('down');
    }
    return real();
  };
  await env.app.connected();
  assert.match(statusText(env), /configuration could not be read/);
  assert.equal(env.ostrom.calls.length, 0);
  await env.wait(5000);
  assert.equal(env.ostrom.calls.length, 0);
  await env.wait(10_000);
  assert.ok(env.ostrom.count('contracts') >= 1);
  assert.match(statusText(env), /^Connected/);
});

test('the id key: made once and stored in Gladys, never in /data; nothing read until stored', async (t) => {
  const store = createMemoryStore();
  const env = await setup({
    store,
    config: { client_id: O.CLIENT_ID, client_secret: O.CLIENT_SECRET },
  });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  const realSet = env.gladys.setConfig.bind(env.gladys);
  let failing = true;
  env.gladys.setConfig = async (c) => {
    if (failing) throw new Error('down');
    return realSet(c);
  };
  await env.start(env.fake.config);
  assert.equal(env.ostrom.calls.length, 0);
  assert.match(statusText(env), /did not store the key/);
  failing = false;
  await env.wait(6 * MINUTE);
  assert.match(env.fake.config.id_key, /^[0-9a-f]{64}$/);
  assert.ok(env.ostrom.count('contracts') >= 1);
  assert.ok(!JSON.stringify(store.data).includes(env.fake.config.id_key));
});

test('a restart keeps the device ids (same key), a contract missing from a read stays offered', async (t) => {
  const store = createMemoryStore();
  const env = await started({ store });
  const id = deviceOf(env).external_id;
  await env.app.stop();
  const ostrom = createOstrom({ contracts: () => O.contracts([]) });
  const later = await started({ store, ostrom, now: O.NOW + 7 * HOUR });
  t.after(() => later.app.stop());
  assert.equal(deviceOf(later).external_id, id);
  assert.equal(ostrom.count('contracts'), 1);
  assert.match(statusText(later), /sees no Ostrom contract/);
});

test('stop() during a read: the request aborted, nothing published after it', async (t) => {
  const ostrom = createOstrom({
    contracts: (call) =>
      new Promise((resolve, reject) =>
        call.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))),
      ),
  });
  const env = await setup({ ostrom });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  await env.start();
  assert.equal(ostrom.count('contracts'), 1);
  const statuses = env.fake.connectionStatuses.length;
  await env.app.stop();
  await env.wait(DAY);
  assert.equal(env.fake.connectionStatuses.length, statuses);
  assert.equal(ostrom.calls.length, 2);
});

test('a late answer of an older start (config saved meanwhile) publishes nothing of its own', async (t) => {
  let release;
  let first = true;
  const ostrom = createOstrom({
    contracts: () => {
      if (!first) return O.contracts([O.contract({ id: 200000001 })]);
      first = false;
      return new Promise((resolve) => (release = () => resolve(O.contracts())));
    },
  });
  const env = await setup({ ostrom });
  registerHandlers(env.gladys, env.app, env.app.log);
  t.after(() => env.app.stop());
  await env.start();
  await env.fake.configUpdated({ ...CONFIG, client_secret: 'another-secret-value' });
  await env.wait(2 * MINUTE);
  release();
  await env.wait(1000);
  const names = env.fake.discoveredDevices.map((d) => d.name);
  assert.deepEqual(names, ['Ostrom electricity (contract …0001)']);
});

test('a quarter already started keeps the price first kept (a retry gets the same answer)', async (t) => {
  const env = await started();
  t.after(() => env.app.stop());
  const now = env.clock.now;
  const past = now - (now % QUARTER) - QUARTER;
  const future = now - (now % QUARTER) + 4 * QUARTER;
  env.app.record(
    KEY,
    new Map([
      [past, 9],
      [future, 8],
    ]),
  );
  assert.equal(env.app.priceFor(KEY, past), O.priceOf(past));
  assert.equal(env.app.priceFor(KEY, future), 8);
});
