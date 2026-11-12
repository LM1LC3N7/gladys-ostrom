// -----------------------------------------------------------------------------
// Reading the Ostrom answers: contracts, prices (quarters, hours, the changes
// of time), consumption. A value that does not read is unknown, never 0.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDynamic,
  keyOf,
  parseConsumption,
  parseContracts,
  parseSpotPrices,
} from '../src/ostrom/model.js';
import { addDays, fromBerlin } from '../src/time.js';
import * as O from './fixtures/ostrom.js';

const { QUARTER, HOUR } = O;

test('contracts: id number or digits, key by HMAC, last 4 digits, postcode checked, at most 4', () => {
  const list = parseContracts(
    O.contracts([
      O.contract(),
      O.contract({ id: '200000001', productCode: 'SIMPLY_FAIR', address: { zip: '1099' } }),
      O.contract({ id: 'abc' }),
      O.contract({ id: O.CONTRACT_ID }),
      O.contract({ id: 3, productCode: 'x\ny' }),
      O.contract({ id: 4 }),
      O.contract({ id: 5 }),
    ]),
    O.ID_KEY,
  );
  assert.equal(list.length, 4);
  const [a, b, c] = list;
  assert.equal(a.id, String(O.CONTRACT_ID));
  assert.equal(a.key, keyOf(O.ID_KEY, 'contract', String(O.CONTRACT_ID)));
  assert.notEqual(a.key, keyOf('b2'.repeat(32), 'contract', String(O.CONTRACT_ID)));
  assert.equal(a.suffix, '3456');
  assert.equal(a.zip, O.ZIP);
  assert.equal(a.dynamic, true);
  assert.equal(b.dynamic, false);
  assert.equal(b.zip, undefined);
  assert.equal(c.product, '');
  assert.equal(parseContracts({ data: 'x' }, O.ID_KEY), undefined);
  assert.equal(parseContracts(null, O.ID_KEY), undefined);
  assert.equal(isDynamic('DynamicTariff', ''), true);
  assert.equal(isDynamic('SIMPLY_FAIR', 'ELECTRICITY'), false);
});

test('prices: cents to EUR per kWh with taxes; fees; a value unreadable is unknown', () => {
  const from = fromBerlin(2026, 11, 11);
  const body = O.spotPrices({ from, to: from + 2 * HOUR });
  body.data[1].grossKwhPrice = null;
  body.data[2].grossKwhTaxAndLevies = '19';
  body.data[3].date = '2026-11-11 00:45';
  // An item without taxes among taxed items: unknown, never the spot price alone.
  body.data[4].grossKwhTaxAndLevies = undefined;
  const parsed = parseSpotPrices(body, from + HOUR);
  assert.equal(parsed.zipKnown, true);
  assert.equal(parsed.prices.get(from), O.priceOf(from));
  assert.equal(parsed.prices.has(from + QUARTER), false);
  assert.equal(parsed.prices.has(from + 2 * QUARTER), false);
  assert.equal(parsed.prices.has(from + 3 * QUARTER), false);
  assert.equal(parsed.prices.has(from + HOUR), false);
  assert.equal(parsed.prices.get(from + HOUR + QUARTER), O.priceOf(from + HOUR));
  assert.equal(parsed.fees, 10.57);
  assert.equal(parseSpotPrices({ data: {} }, from), undefined);
});

test('prices: an hourly answer prices its four quarters; a 30-minute step does not read', () => {
  const from = fromBerlin(2026, 11, 11);
  const parsed = parseSpotPrices(O.spotPrices({ from, to: from + 3 * HOUR, step: HOUR }), from);
  assert.equal(parsed.prices.size, 12);
  assert.equal(parsed.prices.get(from + 3 * QUARTER), O.priceOf(from));
  assert.equal(
    parseSpotPrices(O.spotPrices({ from, to: from + HOUR, step: 2 * QUARTER }), from),
    undefined,
  );
});

test('prices: two prices for one quarter: neither kept; no taxes anywhere: postcode unknown', () => {
  const from = fromBerlin(2026, 11, 11);
  const body = O.spotPrices({ from, to: from + HOUR });
  body.data.push({ ...body.data[0], grossKwhPrice: 99 });
  const parsed = parseSpotPrices(body, from);
  assert.equal(parsed.prices.has(from), false);
  assert.equal(parsed.prices.size, 3);
  const untaxed = parseSpotPrices(O.spotPrices({ from, to: from + HOUR, zip: false }), from);
  assert.equal(untaxed.zipKnown, false);
});

test('prices: the autumn change of time has 100 quarters, the spring one 92', () => {
  for (const [day, count] of [
    [fromBerlin(2026, 10, 25), 100],
    [fromBerlin(2026, 3, 29), 92],
  ]) {
    const end = addDays(day, 1);
    const parsed = parseSpotPrices(O.spotPrices({ from: day, to: end }), day);
    assert.equal(parsed.prices.size, count);
    assert.equal((end - day) / QUARTER, count);
  }
});

test('prices: a price beyond 10 EUR/kWh is not a price', () => {
  const from = fromBerlin(2026, 11, 11);
  const parsed = parseSpotPrices(
    O.spotPrices({ from, to: from + QUARTER, spot: () => 2000 }),
    from,
  );
  assert.equal(parsed.prices.size, 0);
});

test('consumption: ended hours only, split in two halves; conflicts and bad values left out', () => {
  const from = fromBerlin(2026, 11, 10);
  const now = from + 5 * HOUR + 10 * 60_000;
  const body = O.consumption({ from, to: from + 6 * HOUR, kwh: (h) => (h - from) / HOUR + 1 });
  body.data[1].kWh = 251;
  body.data.push({ date: new Date(from + 2 * HOUR).toISOString(), kWh: 7 });
  body.data.push({ date: new Date(from + 30 * 60_000).toISOString(), kWh: 1 });
  const out = parseConsumption(body, now);
  // Hours 0, 3, 4 (1: too large; 2: two values; 5: not ended).
  assert.deepEqual(
    out.map((i) => [(Date.parse(i.starts_at) - from) / 60_000, i.kwh]),
    [
      [0, 0.5],
      [30, 0.5],
      [180, 2],
      [210, 2],
      [240, 2.5],
      [270, 2.5],
    ],
  );
  assert.equal(parseConsumption({}, now), undefined);
});

test('an instant without its zone is never read (never the container time zone)', async () => {
  const { parseInstant } = await import('../src/time.js');
  assert.equal(parseInstant('2026-11-11T10:00:00'), undefined);
  assert.equal(parseInstant('2026-11-11T10:00:00.000Z'), Date.parse('2026-11-11T10:00:00Z'));
  assert.equal(parseInstant('2026-11-11T11:00:00+01:00'), Date.parse('2026-11-11T10:00:00Z'));
  const body = { data: [{ date: '2026-11-11T10:00:00', kWh: 1 }] };
  assert.deepEqual(parseConsumption(body, Date.parse('2026-11-12T00:00:00Z')), []);
});

test('a pause read back from /data is capped to 6 hours', async () => {
  const { validPause } = await import('../src/app.js');
  const now = O.NOW;
  const pause = validPause({ until: now + 30 * 24 * HOUR, count: 1, code: 'server' }, now, 0);
  assert.equal(pause.until - now, 6 * HOUR);
  assert.equal(pause.due, 6 * HOUR);
  assert.equal(validPause({ until: now, count: 1, code: 'other' }, now, 0), undefined);
});
