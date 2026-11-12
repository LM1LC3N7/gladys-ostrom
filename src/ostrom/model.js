// -----------------------------------------------------------------------------
// Reading the answers of the Ostrom API (pure functions). Every value is
// checked: an item that does not read is left out (unknown), never taken as
// 0. A contract number never leaves this file whole: the integration knows a
// contract by an HMAC key and its last 4 digits.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import {
  HALF_HOUR,
  HOUR,
  MAX_CONTRACTS,
  MAX_HOUR_KWH,
  MAX_ITEMS,
  MAX_MONTHLY_FEES,
  MAX_PRICE,
  QUARTER,
} from '../constants.js';
import { parseInstant } from '../time.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** 16 hex digits of an HMAC-SHA-256 of `value` under the id key, per kind. */
export const keyOf = (idKey, kind, value) =>
  createHmac('sha256', Buffer.from(idKey, 'hex'))
    .update(`${kind}\u0000${value}`, 'utf8')
    .digest('hex')
    .slice(0, 16);

/** A short label of the API (product code, type, status): letters, digits, `_- .` only. */
const label = (value, max = 48) =>
  typeof value === 'string' && /^[A-Za-z0-9_ .-]{1,64}$/.test(value.trim())
    ? value.trim().slice(0, max)
    : '';

/** The product of a dynamic tariff (SimplyDynamic, "DynamicTariff" of the test accounts). */
export const isDynamic = (productCode, type) => /dynamic/i.test(`${productCode} ${type}`);

/**
 * The contracts of `GET /contracts`: `[{ id, key, suffix, type, product,
 * status, dynamic, zip, start }]` (at most MAX_CONTRACTS, the id and zip kept
 * in memory only), or undefined when the answer is not a list of contracts.
 */
export function parseContracts(body, idKey) {
  if (!Array.isArray(body?.data)) return undefined;
  const out = [];
  for (const c of body.data.slice(0, 50)) {
    const raw = typeof c?.id === 'number' ? String(c.id) : c?.id;
    if (typeof raw !== 'string' || !/^\d{1,20}$/.test(raw)) continue;
    if (out.some((x) => x.id === raw)) continue;
    const zip = typeof c.address?.zip === 'string' ? c.address.zip.trim() : '';
    const product = label(c.productCode);
    const type = label(c.type);
    out.push({
      id: raw,
      key: keyOf(idKey, 'contract', raw),
      suffix: raw.slice(-4),
      type,
      product,
      status: label(c.status, 32),
      dynamic: isDynamic(product, type),
      zip: /^\d{5}$/.test(zip) ? zip : undefined,
      start: parseInstant(c.startDate),
    });
    if (out.length >= MAX_CONTRACTS) break;
  }
  return out;
}

/**
 * The prices of `GET /spot-prices` (resolution QUARTER_HOUR, with a zip):
 * `{ prices: Map(quarter start ms -> EUR/kWh gross, taxes and levies
 * included), fees: EUR/month | undefined, zipKnown }`, or undefined when the
 * answer does not read. An hourly answer prices its four quarters.
 * `zipKnown` is false when every item has neither taxes nor grid fees (what
 * the API answers without a zip it knows): those prices are not the
 * customer's and are never kept.
 */
export function parseSpotPrices(body, now) {
  if (!Array.isArray(body?.data) || body.data.length > MAX_ITEMS) return undefined;
  const items = [];
  let taxed = false;
  for (const item of body.data) {
    const at = parseInstant(item?.date);
    if (at === undefined || at % QUARTER !== 0) continue;
    if (finite(item.grossKwhTaxAndLevies) && item.grossKwhTaxAndLevies !== 0) taxed = true;
    if (finite(item.grossMonthlyGridFees) && item.grossMonthlyGridFees !== 0) taxed = true;
    items.push({ at, item });
  }
  items.sort((a, b) => a.at - b.at);
  // The length of a slot: the smallest step between two items (15 or 60 minutes).
  let step = QUARTER;
  if (items.length > 1) {
    let min = Infinity;
    for (let i = 1; i < items.length; i += 1) {
      const d = items[i].at - items[i - 1].at;
      if (d > 0 && d < min) min = d;
    }
    if (min !== QUARTER && min !== HOUR && min !== Infinity) return undefined;
    if (min === HOUR) step = HOUR;
  }
  const prices = new Map();
  const conflicts = new Set();
  let fees;
  // The next instant after each item (a duplicate is not one), in one pass back.
  const nextAt = new Array(items.length);
  for (let i = items.length - 1, later = Infinity; i >= 0; i -= 1) {
    nextAt[i] = later;
    if (i > 0 && items[i - 1].at < items[i].at) later = items[i].at;
  }
  for (const [i, { at, item }] of items.entries()) {
    const next = nextAt[i];
    const spot = item.grossKwhPrice;
    const taxes = item.grossKwhTaxAndLevies;
    if (finite(spot) && finite(taxes)) {
      // Cents -> EUR, to a millionth of a euro.
      const price = Math.round((spot + taxes) * 1e4) / 1e6;
      if (Math.abs(price) <= MAX_PRICE) {
        for (let q = at; q < at + step && q < next; q += QUARTER) {
          // Two different prices for one quarter: neither is kept.
          if (prices.has(q) && prices.get(q) !== price) conflicts.add(q);
          prices.set(q, price);
        }
      }
    }
    const base = item.grossMonthlyOstromBaseFee;
    const grid = item.grossMonthlyGridFees;
    if (at <= now && finite(base) && finite(grid) && base >= 0 && grid >= 0) {
      const total = base + grid;
      if (total <= MAX_MONTHLY_FEES) fees = Math.round(total * 100) / 100;
    }
  }
  for (const q of conflicts) prices.delete(q);
  return { prices, fees, zipKnown: taxed };
}

/**
 * The consumption of `GET /contracts/{id}/energy-consumption` (resolution
 * HOUR): the half hours `[{ starts_at, kwh }]` of the hours ended by `now`,
 * each hour split in two equal halves; or undefined when the answer does not
 * read. An hour without a readable value is left out (never 0).
 */
export function parseConsumption(body, now) {
  if (!Array.isArray(body?.data) || body.data.length > MAX_ITEMS) return undefined;
  const hours = new Map();
  const conflicts = new Set();
  for (const item of body.data) {
    const at = parseInstant(item?.date);
    const kwh = item?.kWh;
    if (at === undefined || at % HOUR !== 0 || at + HOUR > now) continue;
    if (!finite(kwh) || kwh < 0 || kwh > MAX_HOUR_KWH) continue;
    if (hours.has(at) && hours.get(at) !== kwh) conflicts.add(at);
    hours.set(at, kwh);
  }
  for (const at of conflicts) hours.delete(at);
  const out = [];
  for (const at of [...hours.keys()].sort((a, b) => a - b)) {
    const half = Math.round((hours.get(at) / 2) * 1e6) / 1e6;
    out.push({ starts_at: new Date(at).toISOString(), kwh: half });
    out.push({ starts_at: new Date(at + HALF_HOUR).toISOString(), kwh: half });
  }
  return out;
}
