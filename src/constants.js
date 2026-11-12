// -----------------------------------------------------------------------------
// Constants of the Ostrom integration: the endpoints, the pace, the bounds and
// the manifest keys (forever: stored in user configs and contracts).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The official Ostrom API (docs.ostrom-api.io), production and sandbox. */
export const ENVIRONMENTS = Object.freeze({
  production: {
    api: 'https://production.ostrom-api.io',
    auth: 'https://auth.production.ostrom-api.io/oauth2/token',
  },
  sandbox: {
    api: 'https://sandbox.ostrom-api.io',
    auth: 'https://auth.sandbox.ostrom-api.io/oauth2/token',
  },
});
// The version follows the release (package.json is in the image).
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const USER_AGENT = `gladys-ostrom/${VERSION} (+https://github.com/LM1LC3N7/gladys-ostrom)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const QUARTER = 15 * MINUTE;
export const HALF_HOUR = 30 * MINUTE;

export const TIME_ZONE = 'Europe/Berlin';
export const CURRENCY = 'EUR';

// --- Requests -----------------------------------------------------------------

/** One request never takes longer (headers and body). */
export const REQUEST_TIMEOUT = 20 * SECOND;
/** A larger answer is cut before it is read whole (3 days of quarters: ~100 kB). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Two requests of the integration are always this far apart (one in flight at a time). */
export const REQUEST_GAP = 2 * SECOND;

// --- Pace -----------------------------------------------------------------------

/** One round an hour at most: what is due in it is read, nothing else. */
export const ROUND_INTERVAL = HOUR;
/** The contracts (product, address zip) every 6 hours. */
export const CONTRACTS_INTERVAL = 6 * HOUR;
/** Tomorrow's prices are loaded by Ostrom between 15:00 and 17:00 (German time). */
export const PRICES_HOUR = 15;
/** The consumption of the created devices: every 3 hours, the last 3 days. */
export const CONSUMPTION_INTERVAL = 3 * HOUR;
export const CONSUMPTION_DAYS = 3;
/** Once a day (the first read after 06:00 in Germany) and for a new device: 7 days. */
export const BACKFILL_DAYS = 7;
export const BACKFILL_HOUR = 6;
/** After a failed read: again after 5, 10, 20, 40 then every 60 minutes. */
export const RETRY_MIN = 5 * MINUTE;
export const RETRY_MAX = HOUR;
/** A 429 without Retry-After: 15 minutes, doubled up to 6 hours. */
export const RATE_LIMIT_PAUSE = 15 * MINUTE;
/** A 5xx: 5 minutes, doubled up to 6 hours. */
export const SERVER_PAUSE = 5 * MINUTE;
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The test button answers at most once a minute with a new request. */
export const TEST_MIN_GAP = MINUTE;
/** A new device or new credentials are read soon, never sooner than this after a read. */
export const CREATED_MIN_GAP = MINUTE;
/** The config is read again after a failure: 5 s doubled up to 5 minutes, for ever. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** /data: waited at most STORE_WAIT; an unreadable one is read again every STORE_RETRY. */
export const STORE_WAIT = 3 * SECOND;
export const STORE_RETRY = 10 * SECOND;
/** A token is renewed this long before its end (or at 80 % of its life when shorter). */
export const TOKEN_MARGIN = 5 * MINUTE;
/** A token without a readable lifetime is used this long. */
export const TOKEN_DEFAULT_LIFE = 30 * MINUTE;
/** The price features are published again at every quarter of an hour (no request). */
export const TICK = QUARTER;
/** The monthly fees read longer ago than this are not published as current. */
export const FEES_MAX_AGE = 2 * DAY;

// --- Bounds -----------------------------------------------------------------------

/** Prices kept in /data to price the past intervals: 40 days of quarters. */
export const PRICE_HISTORY_DAYS = 40;
/** At most this many contracts are read from one answer and kept. */
export const MAX_CONTRACTS = 4;
/** At most this many items of one answer are read (3 days of quarters: 300). */
export const MAX_ITEMS = 2000;
/** A gross price beyond ± this (EUR/kWh) is not a price. */
export const MAX_PRICE = 10;
/** An hour beyond this (kWh) is not a household reading. */
export const MAX_HOUR_KWH = 250;
/** Monthly fees beyond this (EUR) are not fees. */
export const MAX_MONTHLY_FEES = 1000;
export const MAX_STATUS = 400;

// --- Manifest keys (forever) -------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection' };
export const TEMPLATES = { DYNAMIC: 'ostrom-simply-dynamic' };
