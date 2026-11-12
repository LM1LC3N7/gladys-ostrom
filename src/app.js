// -----------------------------------------------------------------------------
// The integration itself: the Ostrom customer's own data read through the
// official Ostrom API (OAuth2 client credentials created by the customer),
// one Gladys device per electricity contract, the smart-meter consumption
// published after the fact (publishEnergyConsumption), the SimplyDynamic
// prices (spot price and taxes of the contract's postcode) kept to price the
// delegated contracts, the pauses and the refused credentials kept in /data,
// the test button. index.js only wires the SDK handlers to it. Read-only:
// nothing is ever changed on the account.
//
// Pace (each attempt kept in /data before the request, so a restart never
// reads sooner): the contracts every 6 hours; the prices when the ones held
// do not reach the end of today (or of tomorrow from 15:00 in Germany, when
// Ostrom loads them), at most once an hour; the consumption of the CREATED
// devices every 3 hours (3 days; 7 days once a day after 06:00 and for a new
// device). A failed read of the contracts is tried again after 5, 10, 20, 40
// then every 60 minutes; a 429 or a 5xx pauses every request (persisted, at
// most 6 hours). The price features are published again at every quarter of
// an hour from what is held: no request.
//
// Two clocks: `now` (wall clock) dates the prices, the consumption and what
// /data keeps; `monotonic` paces the reads, the pauses and the token, so that
// a wall clock set back or forward never stops nor hurries them.
//
// A start (config saved, reconnection) opens a new generation: a late answer
// of an older one publishes nothing and sets no status (checked after every
// await).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { credentialsOf, normalizeConfig } from './config.js';
import {
  BACKFILL_DAYS,
  BACKFILL_HOUR,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  CONSUMPTION_DAYS,
  CONSUMPTION_INTERVAL,
  CONTRACTS_INTERVAL,
  CREATED_MIN_GAP,
  DAY,
  FEES_MAX_AGE,
  HOLES_INTERVAL,
  HOUR,
  MAX_CONTRACTS,
  MAX_PRICE,
  MAX_STATUS,
  PAUSE_MAX,
  PAUSE_MIN,
  PRICE_BACKFILL_DAYS,
  PRICE_HISTORY_DAYS,
  PRICE_WINDOW_DAYS,
  PRICES_HOUR,
  QUARTER,
  RATE_LIMIT_PAUSE,
  RETRY_MAX,
  RETRY_MIN,
  SERVER_PAUSE,
  STORE_RETRY,
  STORE_WAIT,
  TEST_MIN_GAP,
  TICK,
} from './constants.js';
import { FEATURE, buildContractDevice, idsOf, parseDeviceId, priceStates } from './devices.js';
import { both, t } from './i18n.js';
import { OstromError, OstromSession } from './ostrom/client.js';
import { keyOf, parseConsumption, parseContracts, parseSpotPrices } from './ostrom/model.js';
import { FileStore } from './store.js';
import { addDays, berlin, clock, fromBerlin, localDate, startOfDay } from './time.js';

const TIMED_OUT = Symbol('timed out');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const KEY = /^[0-9a-f]{16}$/;
/** Errors that pause every request. */
const PAUSING = new Set(['rate_limited', 'server']);
/** Errors that stop a round at once (the next kind of read would meet them too). */
const STOPPING = new Set(['rate_limited', 'server', 'refused', 'stopped']);
const ID_KEY = /^[0-9a-f]{64}$/;

/** 8 bits of a salted hash of the credentials: nothing to find them back from. */
export const tagOf = (salt, credentials) =>
  createHash('sha256')
    .update(
      `${salt}\u0000${credentials.environment}\u0000${credentials.clientId}\u0000${credentials.clientSecret}`,
      'utf8',
    )
    .digest()[0];

/** A pause read back from /data, its rest capped to PAUSE_MAX; undefined when invalid. */
export function validPause(pause, now, mono) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    !PAUSING.has(pause.code)
  ) {
    return undefined;
  }
  const left = Math.min(Math.max(0, pause.until - now), PAUSE_MAX);
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 16),
    code: pause.code,
    detail: typeof pause.detail === 'string' ? pause.detail.slice(0, 24) : null,
  };
}

export function validRefused(refused) {
  return refused &&
    typeof refused.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(refused.salt) &&
    Number.isInteger(refused.tag) &&
    refused.tag >= 0 &&
    refused.tag < 256
    ? {
        salt: refused.salt,
        tag: refused.tag,
        oauth:
          typeof refused.oauth === 'string' && /^[a-z_]{1,40}$/.test(refused.oauth)
            ? refused.oauth
            : null,
      }
    : undefined;
}

function validContracts(contracts) {
  const out = [];
  for (const c of Array.isArray(contracts) ? contracts.slice(0, MAX_CONTRACTS) : []) {
    if (!KEY.test(c?.key ?? '') || typeof c.suffix !== 'string' || !/^\d{1,4}$/.test(c.suffix))
      continue;
    out.push({
      key: c.key,
      suffix: c.suffix,
      dynamic: c.dynamic === true,
      product:
        typeof c.product === 'string' && /^[A-Za-z0-9_ .-]{0,48}$/.test(c.product) ? c.product : '',
      seen: finite(c.seen) ? c.seen : 0,
    });
  }
  return out;
}

/** The prices kept: { contractKey: { quarterIndex: EUR/kWh } }, bounded. */
function validPrices(prices, now) {
  const out = {};
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return out;
  const oldest = Math.floor((now - PRICE_HISTORY_DAYS * DAY) / QUARTER);
  const newest = Math.floor((now + 3 * DAY) / QUARTER);
  for (const [key, slots] of Object.entries(prices).slice(0, MAX_CONTRACTS)) {
    if (!KEY.test(key) || !slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
    const kept = {};
    for (const [index, price] of Object.entries(slots).slice(0, 6000)) {
      const i = Number(index);
      if (
        Number.isInteger(i) &&
        i >= oldest &&
        i <= newest &&
        finite(price) &&
        Math.abs(price) <= MAX_PRICE
      )
        kept[i] = price;
    }
    out[key] = kept;
  }
  return out;
}

const bound = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const codeOf = (err) =>
  err instanceof OstromError
    ? err.status && err.code !== 'rate_limited' && err.code !== 'server'
      ? `${err.code} ${err.status}`
      : err.code
    : 'bad_response';

export class OstromApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = { setTimeout, clearTimeout },
    store = new FileStore(),
    fetchImpl = (...args) => globalThis.fetch(...args),
    random = (n) => randomBytes(n),
    requestGap,
    requestTimeout,
    urls,
  }) {
    this.gladys = gladys;
    this.log = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.requestGap = requestGap;
    this.requestTimeout = requestTimeout;
    this.urls = urls;

    this.gen = 0;
    this.stopped = false;
    this.stopEpoch = 0;
    this.config = normalizeConfig({});
    this.session = undefined;
    this.credKey = undefined;

    /** What /data keeps. */
    this.data = {
      lastContracts: null,
      lastPrices: null,
      lastHoles: null,
      lastConsumption: null,
      lastFull: null,
      failures: 0,
      pause: null,
      refused: null,
      contracts: [],
      backfilled: [],
      prices: {},
      keyTag: null,
    };
    this.storeState = 'pending';
    this.loading = null;
    this.storeTimer = null;
    this.pause = undefined;
    this.refused = undefined;

    /** The contracts read in this process (with the numbers and postcodes, memory only). */
    this.contracts = undefined;
    this.fees = new Map();
    this.created = new Set();

    this.lastContractsMono = undefined;
    this.lastPricesMono = undefined;
    this.lastHolesMono = undefined;
    this.pastMissing = false;
    this.lastConsumptionMono = undefined;
    this.contractsOkAt = undefined;
    this.failures = 0;
    this.lastError = undefined;
    this.pricesError = undefined;
    this.zipUnknown = false;
    this.consumptionError = undefined;
    this.pendingBackfill = new Set();

    this.roundTimer = null;
    this.tickTimer = null;
    this.configTimer = null;
    this.configDelay = 0;
    this.running = Promise.resolve();
    this.sleeps = new Set();
    this.lastStatus = undefined;
    this.lastTest = undefined;
    this.dueMono = undefined;
    this.lastDiscovery = undefined;
    this.idKey = undefined;
    this.idKeyPending = undefined;
    this.idKeyDue = undefined;
    this.idKeyFailures = 0;
    this.freshConfig = false;
  }

  gone(gen) {
    return this.stopped || gen !== this.gen;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Every (re)connection to Gladys: read the config (retried for ever), then start. */
  async connected() {
    const epoch = this.stopEpoch;
    this.stopped = false;
    this.lastStatus = undefined;
    // What Gladys holds may be older than this process knows: published again.
    this.gladys.forgetPublishedStates?.();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = null;
    }
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped || epoch !== this.stopEpoch) return;
      this.configDelay = Math.min(
        CONFIG_RETRY_MAX,
        Math.max(CONFIG_RETRY_MIN, this.configDelay * 2),
      );
      this.log.warn(
        `Configuration not read (${err?.name ?? 'Error'}): again in ${this.configDelay / 1000} s`,
      );
      await this.setStatus(false, both('configUnread'));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = null;
        this.connected().catch((e) => this.log.error(`Start failed (${e?.name ?? 'Error'})`));
      }, this.configDelay);
      return;
    }
    if (this.stopped || epoch !== this.stopEpoch) return;
    this.configDelay = 0;
    await this.start(config);
  }

  async start(rawConfig) {
    this.stopped = false;
    const gen = ++this.gen;
    const config = normalizeConfig(rawConfig);
    const credentials = credentialsOf(config);
    const credKey = JSON.stringify(credentials);
    const changed = credKey !== this.credKey;
    // Other credentials entered by the user: read soon (not at a restart),
    // and always tried, even when their 8-bit tag matches the refused one (a
    // restart keeps the tag only).
    if (changed && this.credKey !== undefined) {
      this.freshConfig = true;
      if (this.refused) {
        this.refused = undefined;
        this.data.refused = null;
      }
    }
    this.takeIdKey(rawConfig);
    this.config = config;
    if (changed || !this.session) {
      this.session?.close();
      this.session = config.problem
        ? undefined
        : new OstromSession({
            credentials,
            fetchImpl: this.fetchImpl,
            monotonic: this.monotonic,
            sleep: (ms) => this.sleep(ms),
            ...(this.urls ? { urls: this.urls } : {}),
            ...(this.requestTimeout ? { timeout: this.requestTimeout } : {}),
            ...(this.requestGap !== undefined ? { gap: this.requestGap } : {}),
          });
      this.credKey = credKey;
      if (changed) {
        // Other credentials (or another environment): what was read belongs to the old ones.
        this.contracts = undefined;
        this.fees.clear();
        this.failures = 0;
        this.lastError = undefined;
        this.pricesError = undefined;
        this.zipUnknown = false;
        this.pastMissing = false;
        this.consumptionError = undefined;
      }
    }
    this.clearRound();
    await this.ready();
    if (this.gone(gen)) return;
    await this.save();
    if (this.gone(gen)) return;
    await this.ensureIdKey(gen);
    if (this.gone(gen)) return;
    await this.refreshCreated(gen);
    if (this.gone(gen)) return;
    await this.publishDiscovery(gen);
    if (this.gone(gen)) return;
    this.schedule(gen);
    this.armTick(gen);
    await this.publishPrices(gen);
    await this.report(gen);
  }

  /** The id key stored in the Gladys config (outside the form), when valid. */
  takeIdKey(rawConfig) {
    const key = typeof rawConfig?.id_key === 'string' ? rawConfig.id_key : '';
    if (ID_KEY.test(key)) this.adoptIdKey(key);
  }

  /** The key stored in Gladys becomes the one in use; what depended on another one is forgotten. */
  adoptIdKey(key) {
    if (key === this.idKey) return;
    if (this.idKey) {
      this.contracts = undefined;
      this.lastDiscovery = undefined;
    }
    this.idKey = key;
    this.checkKeyTag();
  }

  /**
   * /data keeps 4 bytes of an HMAC of the id key (nothing to find the key
   * back from): when the key in use is another one, the contracts, prices and
   * backfills of /data (keyed by the old one) go.
   */
  checkKeyTag() {
    if (!this.idKey || this.storeState !== 'ok') return;
    const tag = keyOf(this.idKey, 'tag', 'ostrom').slice(0, 8);
    if (this.data.keyTag && this.data.keyTag !== tag) {
      this.data.contracts = [];
      this.data.prices = {};
      this.data.backfilled = [];
      this.lastDiscovery = undefined;
    }
    this.data.keyTag = tag;
  }

  /**
   * The secret of the device keys (HMAC): read from the Gladys config, made
   * once and stored there (never in /data, never shown in the form). Until it
   * is stored, nothing is read nor published (the ids depend on it). One
   * attempt at a time, spaced 5 s doubled up to 5 min after a failure; the key
   * adopted is the one Gladys holds once the write is done (read back).
   */
  ensureIdKey(gen) {
    if (this.idKey) return Promise.resolve(true);
    if (this.idKeyPending) return this.idKeyPending;
    if (this.idKeyDue !== undefined && this.monotonic() < this.idKeyDue)
      return Promise.resolve(false);
    this.idKeyPending = this.storeIdKey(gen).finally(() => {
      this.idKeyPending = undefined;
    });
    return this.idKeyPending;
  }

  async storeIdKey(gen) {
    const stored = (config) => (ID_KEY.test(config?.id_key ?? '') ? config.id_key : undefined);
    try {
      let key = stored(await this.gladys.getConfig());
      if (!key) {
        await this.gladys.setConfig({ id_key: this.random(32).toString('hex') });
        // Read back: the key Gladys keeps is the only one used.
        key = stored(await this.gladys.getConfig());
        if (!key) throw new Error('not stored');
      }
      if (this.stopped && this.gone(gen)) return false;
      this.idKeyFailures = 0;
      this.idKeyDue = undefined;
      this.adoptIdKey(key);
      await this.save();
      return true;
    } catch (err) {
      this.idKeyFailures += 1;
      const wait = Math.min(CONFIG_RETRY_MAX, CONFIG_RETRY_MIN * 2 ** (this.idKeyFailures - 1));
      this.idKeyDue = this.monotonic() + wait;
      this.log.warn(
        `Id key not stored in Gladys (${err?.name ?? 'Error'}): again in ${wait / 1000} s`,
      );
      return false;
    }
  }

  async stop() {
    this.stopped = true;
    this.stopEpoch += 1;
    this.gen += 1;
    this.clearRound();
    for (const timer of [this.tickTimer, this.configTimer, this.storeTimer]) {
      if (timer) this.timers.clearTimeout(timer);
    }
    this.tickTimer = null;
    this.configTimer = null;
    this.storeTimer = null;
    this.session?.close();
    this.session = undefined;
    this.credKey = undefined;
    for (const wake of this.sleeps) wake();
    this.sleeps.clear();
    await this.running.catch(() => {});
    await this.save();
    await this.bounded(Promise.resolve(this.store.flush?.()), STORE_WAIT).catch(() => {});
  }

  /** `promise`, or TIMED_OUT after `ms` (the timer is cleared either way). */
  bounded(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => resolve(TIMED_OUT), ms);
      promise.then(
        (value) => {
          this.timers.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          this.timers.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Resolves after `ms` (injected timers), or at once when the app stops. */
  sleep(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        this.timers.clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve();
      };
      timer = this.timers.setTimeout(wake, Math.max(0, ms));
      this.sleeps.add(wake);
    });
  }

  // --- /data ----------------------------------------------------------------------

  /** Waits for /data at most STORE_WAIT; without it, nothing is ever saved. */
  async ready() {
    if (this.storeState === 'ok') return;
    const result = await this.bounded(this.loadStore(), STORE_WAIT);
    if (result === TIMED_OUT && this.storeState === 'pending') {
      this.storeState = 'unreadable';
      this.armStoreRetry();
    }
  }

  armStoreRetry() {
    if (this.storeState === 'ok' || this.stopped || this.storeTimer) return;
    this.storeTimer = this.timers.setTimeout(() => {
      this.storeTimer = null;
      this.loadStore();
    }, STORE_RETRY);
  }

  /** One read of /data at a time; an unreadable one is read again every STORE_RETRY. */
  loadStore() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const raw = await this.store.load();
        const late = this.storeState === 'unreadable';
        this.merge(raw);
        this.storeState = 'ok';
        // What /data keeps under another id key goes.
        this.checkKeyTag();
        if (late) await this.afterLateLoad();
      } catch (err) {
        this.storeState = 'unreadable';
        this.log.warn(
          `/data unreadable (${err?.name ?? 'Error'}): read again in ${STORE_RETRY / 1000} s`,
        );
      } finally {
        this.loading = null;
      }
      this.armStoreRetry();
    })();
    return this.loading;
  }

  async afterLateLoad() {
    if (this.storeState !== 'ok' || this.stopped) return;
    const gen = this.gen;
    await this.save();
    if (this.gone(gen)) return;
    if (this.roundTimer) this.schedule(gen);
    await this.report(gen);
  }

  /** /data read back, merged with what this process learnt meanwhile (the stricter wins). */
  merge(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const now = this.now();
    const mono = this.monotonic();
    for (const key of ['lastContracts', 'lastPrices', 'lastHoles', 'lastConsumption']) {
      // A time of /data in the future is invalid: ignored.
      if (
        finite(data[key]) &&
        data[key] <= now &&
        !(finite(this.data[key]) && this.data[key] > data[key])
      ) {
        this.data[key] = data[key];
      }
    }
    if (
      typeof data.lastFull === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(data.lastFull) &&
      !this.data.lastFull
    ) {
      this.data.lastFull = data.lastFull;
    }
    // The failed reads in a row: a restart keeps their spacing (never the full interval).
    if (Number.isInteger(data.failures) && data.failures > this.failures) {
      this.failures = Math.min(data.failures, 16);
    }
    const pause = validPause(data.pause, now, mono);
    if (pause && !(this.pause && this.pause.until >= pause.until)) {
      this.pause = pause;
      this.data.pause = {
        until: pause.until,
        count: pause.count,
        code: pause.code,
        detail: pause.detail,
      };
    }
    const refused = validRefused(data.refused);
    if (refused && !this.refused) {
      this.refused = refused;
      this.data.refused = refused;
    }
    if (!this.data.contracts.length) this.data.contracts = validContracts(data.contracts);
    const backfilled = Array.isArray(data.backfilled)
      ? data.backfilled.filter((k) => KEY.test(k)).slice(0, 16)
      : [];
    this.data.backfilled = [...new Set([...this.data.backfilled, ...backfilled])];
    if (typeof data.keyTag === 'string' && /^[0-9a-f]{8}$/.test(data.keyTag) && !this.data.keyTag) {
      this.data.keyTag = data.keyTag;
    }
    const kept = validPrices(data.prices, now);
    for (const [key, slots] of Object.entries(kept)) {
      this.data.prices[key] = { ...slots, ...(this.data.prices[key] ?? {}) };
    }
  }

  async save() {
    if (this.storeState !== 'ok') return false;
    const snapshot = {
      version: 1,
      lastContracts: this.data.lastContracts,
      lastPrices: this.data.lastPrices,
      lastHoles: this.data.lastHoles,
      lastConsumption: this.data.lastConsumption,
      lastFull: this.data.lastFull,
      failures: this.failures,
      pause: this.data.pause,
      refused: this.data.refused,
      contracts: this.data.contracts,
      backfilled: this.data.backfilled,
      prices: this.data.prices,
      keyTag: this.data.keyTag,
    };
    try {
      // A slow volume never holds a read: the write goes on in the background.
      const done = this.store.save(snapshot);
      done.catch((err) => this.log.warn(`/data not saved (${err?.name ?? 'Error'})`));
      return (
        (await this.bounded(
          done.then(() => true),
          STORE_WAIT,
        )) === true
      );
    } catch (err) {
      this.log.warn(`/data not saved (${err?.name ?? 'Error'})`);
      return false;
    }
  }

  // --- Pace ------------------------------------------------------------------------

  clearRound() {
    if (this.roundTimer) {
      this.timers.clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }
  }

  pauseActive(mono = this.monotonic()) {
    return Boolean(this.pause && this.pause.due > mono);
  }

  isRefused() {
    return Boolean(
      this.refused && this.refused.tag === tagOf(this.refused.salt, credentialsOf(this.config)),
    );
  }

  /** The monotonic time a kind of read is due, from this process or from /data. */
  dueOf(lastMono, lastWall, interval, mono, now) {
    if (lastMono !== undefined) return lastMono + interval;
    // /data not read: its last read is unknown, a whole interval is waited.
    if (this.storeState !== 'ok') return mono + interval;
    return finite(lastWall) && lastWall <= now
      ? mono + Math.max(0, interval - (now - lastWall))
      : mono;
  }

  contractsDue(mono, now) {
    const wait = this.freshConfig
      ? CREATED_MIN_GAP
      : this.failures > 0
        ? Math.min(RETRY_MAX, RETRY_MIN * 2 ** (this.failures - 1))
        : CONTRACTS_INTERVAL;
    return this.dueOf(this.lastContractsMono, this.data.lastContracts, wait, mono, now);
  }

  /** The dynamic contracts of this process with a postcode: the ones whose prices are read. */
  priceTargets() {
    return (this.contracts ?? []).filter((c) => c.dynamic && c.zip);
  }

  /** Whether every target has a price for every quarter from `from` to `until`. */
  covered(targets, from, until) {
    for (const c of targets) {
      const kept = this.data.prices[c.key] ?? {};
      for (let q = from - (from % QUARTER); q < until; q += QUARTER) {
        if (kept[Math.floor(q / QUARTER)] === undefined) return false;
      }
    }
    return true;
  }

  /**
   * The first past quarter without a price, as far back as the core may ask
   * (31 days, never before a contract's start); undefined when none.
   */
  firstHole(targets, now) {
    let first;
    for (const c of targets) {
      let from = addDays(now, -PRICE_BACKFILL_DAYS);
      if (finite(c.start) && c.start > from) from = c.start;
      const kept = this.data.prices[c.key] ?? {};
      // Up to yesterday: the recent window (yesterday to tomorrow) is the
      // hourly read's business.
      const until = addDays(now, -1);
      for (
        let q = from - (from % QUARTER);
        q < until && (first === undefined || q < first);
        q += QUARTER
      ) {
        if (kept[Math.floor(q / QUARTER)] === undefined) {
          first = q;
          break;
        }
      }
    }
    return first;
  }

  /** The end of the prices needed now: today, or tomorrow too from 15:00 in Germany. */
  neededUntil(now) {
    return addDays(now, berlin(now).h >= PRICES_HOUR ? 2 : 1);
  }

  pricesDue(mono, now) {
    const targets = this.priceTargets();
    if (!targets.length) return Infinity;
    // Never sooner than an hour after the last read (whatever is missing); a
    // postcode Ostrom does not know is not asked again before 6 hours.
    const gap = this.zipUnknown ? CONTRACTS_INTERVAL : HOUR;
    const hourly = this.dueOf(this.lastPricesMono, this.data.lastPrices, gap, mono, now);
    if (!this.covered(targets, now, this.neededUntil(now))) return hourly;
    // All held: the next read when tomorrow's prices are needed (the next 15:00 in Germany).
    const t = berlin(now);
    let at = fromBerlin(t.y, t.mo, t.d, PRICES_HOUR);
    if (at <= now) {
      const n = berlin(addDays(now, 1));
      at = fromBerlin(n.y, n.mo, n.d, PRICES_HOUR);
    }
    return Math.max(hourly, mono + (at - now));
  }

  /**
   * A past quarter without a price (before yesterday) blocks every delegated
   * request of its billing period: read again on its own pace, at most every
   * 6 hours, never mixed with the recent read.
   */
  holesDue(mono, now) {
    const targets = this.priceTargets();
    if (!targets.length || this.firstHole(targets, now) === undefined) return Infinity;
    return this.dueOf(this.lastHolesMono, this.data.lastHoles, HOLES_INTERVAL, mono, now);
  }

  consumptionDue(mono, now) {
    const targets = this.consumptionTargets();
    if (!targets.length) return Infinity;
    const due = this.dueOf(
      this.lastConsumptionMono,
      this.data.lastConsumption,
      CONSUMPTION_INTERVAL,
      mono,
      now,
    );
    // A new device: soon, but never sooner than CREATED_MIN_GAP after a read.
    if (targets.some((c) => this.pendingBackfill.has(c.key))) {
      return Math.min(
        due,
        this.dueOf(this.lastConsumptionMono, this.data.lastConsumption, CREATED_MIN_GAP, mono, now),
      );
    }
    return due;
  }

  /** The next round: when the first kind of read is due, never during a pause or a refusal. */
  schedule(gen) {
    if (this.gone(gen)) return;
    this.clearRound();
    if (!this.session || this.isRefused()) {
      this.dueMono = undefined;
      return;
    }
    const mono = this.monotonic();
    const now = this.now();
    let due = this.contractsDue(mono, now);
    // The prices and the consumption need the contracts read in this process.
    if (this.contracts) {
      due = Math.min(
        due,
        this.pricesDue(mono, now),
        this.holesDue(mono, now),
        this.consumptionDue(mono, now),
      );
    }
    if (this.pause) due = Math.max(due, this.pause.due);
    this.dueMono = Math.max(due, mono);
    this.roundTimer = this.timers.setTimeout(() => {
      this.roundTimer = null;
      this.running = this.round(gen).catch((err) =>
        this.log.error(`Round failed (${err?.name ?? 'Error'})`),
      );
    }, this.dueMono - mono);
  }

  /** The price features again at every quarter of an hour (no request). */
  armTick(gen) {
    if (this.tickTimer) this.timers.clearTimeout(this.tickTimer);
    const now = this.now();
    // On the next quarter (wall clock: the prices are), a second after it.
    const wait = Math.min(TICK, QUARTER - (now % QUARTER) + 1000);
    this.tickTimer = this.timers.setTimeout(() => {
      this.tickTimer = null;
      if (this.gone(gen)) return;
      this.publishPrices(gen)
        .catch(() => {})
        .then(() => {
          if (!this.gone(gen)) this.armTick(gen);
        });
    }, wait);
  }

  // --- Reads -------------------------------------------------------------------------

  async round(gen) {
    if (this.gone(gen) || !this.session || this.isRefused()) return;
    if (this.pauseActive()) {
      this.schedule(gen);
      return;
    }
    try {
      if (!this.contracts || this.contractsDue(this.monotonic(), this.now()) <= this.monotonic()) {
        await this.readContracts(gen);
      }
      if (this.gone(gen)) return;
      if (
        this.contracts &&
        !this.pauseActive() &&
        this.pricesDue(this.monotonic(), this.now()) <= this.monotonic()
      ) {
        await this.readPrices(gen);
      }
      if (this.gone(gen)) return;
      if (
        this.contracts &&
        !this.pauseActive() &&
        this.holesDue(this.monotonic(), this.now()) <= this.monotonic()
      ) {
        await this.readHoles(gen);
      }
      if (this.gone(gen)) return;
      if (
        this.contracts &&
        !this.pauseActive() &&
        this.consumptionDue(this.monotonic(), this.now()) <= this.monotonic()
      ) {
        await this.readConsumption(gen);
      }
    } catch (err) {
      if (this.gone(gen)) return;
      await this.failed(gen, err);
    }
    if (this.gone(gen)) return;
    this.schedule(gen);
    await this.report(gen);
  }

  /** A read failed: a refusal, a pause or a passing error (retried later). */
  async failed(gen, err) {
    const code = err instanceof OstromError ? err.code : 'bad_response';
    if (code === 'stopped') return;
    if (code === 'refused') {
      await this.refuse(err);
      return;
    }
    if (PAUSING.has(code)) {
      await this.setPause(err);
      return;
    }
    this.lastError = codeOf(err);
    this.log.warn(`Ostrom not read (${this.lastError})`);
    // The count of failures in a row is kept: a restart keeps their spacing.
    await this.save();
  }

  async refuse(err) {
    const salt = this.random(16).toString('hex');
    this.refused = {
      salt,
      tag: tagOf(salt, credentialsOf(this.config)),
      oauth: err.oauth ?? null,
    };
    this.data.refused = this.refused;
    this.log.warn(
      `Ostrom refused the client credentials (${err.oauth ?? 'refused'}): no request until they change or Test succeeds`,
    );
    this.clearRound();
    await this.save();
  }

  async setPause(err) {
    const now = this.now();
    const mono = this.monotonic();
    const count = Math.min((this.pause?.code === err.code ? this.pause.count : 0) + 1, 16);
    const base = err.code === 'rate_limited' ? RATE_LIMIT_PAUSE : SERVER_PAUSE;
    const asked = finite(err.retryAfter) && err.retryAfter > 0 ? err.retryAfter : 0;
    const ms = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, asked, base * 2 ** (count - 1)));
    const detail = err.status ? `HTTP ${err.status}` : null;
    this.pause = { until: now + ms, due: mono + ms, count, code: err.code, detail };
    this.data.pause = { until: now + ms, count, code: err.code, detail };
    this.log.warn(`Ostrom paused until ${clock(now + ms)} (${detail ?? err.code})`);
    await this.save();
  }

  /** A request answered: the pause is over and its count forgotten. */
  async clearPause() {
    if (!this.pause && !this.data.pause) return;
    this.pause = undefined;
    this.data.pause = null;
    await this.save();
  }

  async readContracts(gen) {
    const session = this.session;
    // The attempt is kept BEFORE anything: a restart, or a key not stored, never reads sooner.
    this.freshConfig = false;
    this.lastContractsMono = this.monotonic();
    this.data.lastContracts = this.now();
    await this.save();
    if (this.gone(gen)) return;
    if (!(await this.ensureIdKey(gen))) {
      this.failures = Math.min(this.failures + 1, 16);
      throw new OstromError('gladys_config');
    }
    if (this.gone(gen)) return;
    let contracts;
    try {
      contracts = parseContracts(await session.get('/contracts'), this.idKey);
      if (!contracts) throw new OstromError('bad_response');
    } catch (err) {
      this.failures = Math.min(this.failures + 1, 16);
      throw err;
    }
    if (this.gone(gen)) return;
    await this.clearPause();
    if (this.gone(gen)) return;
    this.failures = 0;
    this.lastError = undefined;
    this.contracts = contracts;
    this.contractsOkAt = this.now();
    // The contracts seen are merged, never replaced: a read without one keeps
    // it (and its prices); at most MAX_CONTRACTS, the least recently seen out.
    const now = this.now();
    const seen = contracts.map((c) => ({
      key: c.key,
      suffix: c.suffix,
      dynamic: c.dynamic,
      product: c.product,
      seen: now,
    }));
    this.data.contracts = [
      ...seen,
      ...this.data.contracts.filter((x) => !seen.some((c) => c.key === x.key)),
    ]
      .sort((a, b) => b.seen - a.seen)
      .slice(0, MAX_CONTRACTS);
    this.prunePrices();
    await this.save();
    if (this.gone(gen)) return;
    // Published again when anything offered changed.
    await this.publishDiscovery(gen, { onlyChanged: true });
  }

  /** The prices of every postcode of the dynamic contracts (yesterday to the end of tomorrow). */
  async readPrices(gen) {
    const now = this.now();
    this.lastPricesMono = this.monotonic();
    this.data.lastPrices = now;
    await this.save();
    if (this.gone(gen)) return;
    const targets = this.priceTargets();
    let problem;
    let zipUnknown = false;
    // Yesterday to the end of tomorrow: the only window that says whether
    // Ostrom knows the postcode, never held up by the past ones.
    for (const zip of [...new Set(targets.map((c) => c.zip))]) {
      let parsed;
      try {
        parsed = await this.fetchPrices(gen, zip, addDays(now, -1), addDays(now, 2));
        if (parsed === undefined) return;
      } catch (err) {
        if (STOPPING.has(err?.code)) throw err;
        problem = codeOf(err);
        this.log.warn(`Prices not read (${problem})`);
        continue;
      }
      if (!parsed.zipKnown) {
        zipUnknown = true;
        continue;
      }
      for (const c of targets.filter((x) => x.zip === zip)) {
        this.record(c.key, parsed.prices);
        if (parsed.fees !== undefined) {
          this.fees.set(c.key, { value: parsed.fees, mono: this.monotonic() });
        }
      }
    }
    if (this.gone(gen)) return;
    await this.clearPause();
    this.pricesError = problem;
    this.zipUnknown = zipUnknown;
    this.prunePrices();
    await this.save();
    if (this.gone(gen)) return;
    await this.publishPrices(gen);
  }

  /** One window of prices; undefined when the start is gone. */
  async fetchPrices(gen, zip, from, to) {
    const body = await this.session.get('/spot-prices', {
      startDate: new Date(from).toISOString(),
      endDate: new Date(to).toISOString(),
      resolution: 'QUARTER_HOUR',
      zip,
    });
    if (this.gone(gen)) return undefined;
    const parsed = parseSpotPrices(body, this.now());
    if (!parsed) throw new OstromError('bad_response');
    return parsed;
  }

  /**
   * The past quarters without a price (before yesterday, 31 days back at
   * most), by windows of 20 days. A window with no taxed item means "days not
   * given" (Ostrom may not serve the past): the hole stays, nothing else
   * changes (the postcode is judged by the recent window only).
   */
  async readHoles(gen) {
    const now = this.now();
    this.lastHolesMono = this.monotonic();
    this.data.lastHoles = now;
    await this.save();
    if (this.gone(gen)) return;
    const targets = this.priceTargets();
    const hole = this.firstHole(targets, now);
    if (hole !== undefined) {
      const end = addDays(now, -1);
      for (const zip of [...new Set(targets.map((c) => c.zip))]) {
        for (let from = startOfDay(hole); from < end;) {
          const to = Math.min(end, addDays(from, PRICE_WINDOW_DAYS));
          let parsed;
          try {
            parsed = await this.fetchPrices(gen, zip, from, to);
            if (parsed === undefined) return;
          } catch (err) {
            if (STOPPING.has(err?.code)) throw err;
            this.log.warn(`Past prices not read (${codeOf(err)})`);
          }
          from = to;
          if (!parsed?.zipKnown) continue;
          for (const c of targets.filter((x) => x.zip === zip)) this.record(c.key, parsed.prices);
        }
      }
    }
    if (this.gone(gen)) return;
    this.pastMissing = this.firstHole(targets, this.now()) !== undefined;
    this.prunePrices();
    await this.save();
  }

  /** Prices kept in /data; a quarter already started keeps the price kept for it. */
  record(key, prices) {
    const now = this.now();
    const kept = this.data.prices[key] ?? {};
    for (const [q, price] of prices) {
      const index = Math.floor(q / QUARTER);
      if (q <= now && kept[index] !== undefined) continue;
      if (q > now + 3 * DAY) continue;
      kept[index] = price;
    }
    this.data.prices[key] = kept;
  }

  /** Prices leave /data by their age (40 days) only, or with their contract (beyond the 4 kept). */
  prunePrices() {
    const oldest = Math.floor((this.now() - PRICE_HISTORY_DAYS * DAY) / QUARTER);
    for (const [key, kept] of Object.entries(this.data.prices)) {
      if (
        !(this.contracts ?? []).some((c) => c.key === key) &&
        !this.data.contracts.some((c) => c.key === key)
      ) {
        delete this.data.prices[key];
        continue;
      }
      for (const index of Object.keys(kept)) if (Number(index) < oldest) delete kept[index];
    }
  }

  /** The created devices with a consumption feature, among the contracts read. */
  consumptionTargets() {
    return (this.contracts ?? []).filter((c) =>
      this.created.has(idsOf(this.gladys, c.key).feature(FEATURE.CONSUMPTION)),
    );
  }

  async readConsumption(gen) {
    const session = this.session;
    const now = this.now();
    this.lastConsumptionMono = this.monotonic();
    this.data.lastConsumption = now;
    const today = localDate(now);
    const full = this.data.lastFull !== today && berlin(now).h >= BACKFILL_HOUR;
    await this.save();
    if (this.gone(gen)) return;
    let problem;
    for (const c of this.consumptionTargets()) {
      const backfill = full || !this.data.backfilled.includes(c.key);
      const days = backfill ? BACKFILL_DAYS : CONSUMPTION_DAYS;
      let intervals;
      try {
        const body = await session.get(
          `/contracts/${encodeURIComponent(c.id)}/energy-consumption`,
          {
            startDate: new Date(addDays(now, -days)).toISOString(),
            endDate: new Date(now - (now % HOUR)).toISOString(),
            resolution: 'HOUR',
          },
        );
        if (this.gone(gen)) return;
        intervals = parseConsumption(body, this.now());
        if (!intervals) throw new OstromError('bad_response');
      } catch (err) {
        if (STOPPING.has(err?.code)) throw err;
        // One contract failing never stops the others.
        problem = codeOf(err);
        this.log.warn(`Consumption not read (${problem})`);
        continue;
      }
      const feature = idsOf(this.gladys, c.key).feature(FEATURE.CONSUMPTION);
      try {
        for (let i = 0; i < intervals.length; i += 2000) {
          await this.gladys.publishEnergyConsumption(feature, intervals.slice(i, i + 2000));
          if (this.gone(gen)) return;
        }
        this.pendingBackfill.delete(c.key);
        if (!this.data.backfilled.includes(c.key)) this.data.backfilled.push(c.key);
      } catch (err) {
        problem = 'gladys';
        this.log.warn(`Consumption not published (${err?.name ?? 'Error'})`);
      }
    }
    if (this.gone(gen)) return;
    await this.clearPause();
    this.consumptionError = problem;
    if (full && !problem) this.data.lastFull = today;
    this.data.backfilled = this.data.backfilled.slice(-16);
    await this.save();
  }

  // --- Gladys --------------------------------------------------------------------------

  async refreshCreated(gen) {
    try {
      const devices = await this.bounded(Promise.resolve(this.gladys.getDevices()), 10_000);
      if (this.gone(gen) || devices === TIMED_OUT || !Array.isArray(devices)) return;
      this.created = new Set();
      for (const d of devices) this.addCreated(d);
    } catch (err) {
      this.log.warn(`Devices not read from Gladys (${err?.name ?? 'Error'})`);
    }
  }

  addCreated(device) {
    if (!parseDeviceId(device?.external_id)) return;
    this.created.add(device.external_id);
    for (const f of device.features ?? []) if (f?.external_id) this.created.add(f.external_id);
  }

  async onDeviceCreated(device) {
    const key = parseDeviceId(device?.external_id);
    if (!key) return;
    this.addCreated(device);
    const gen = this.gen;
    if (!this.data.backfilled.includes(key)) this.pendingBackfill.add(key);
    // Its values from what is held, then its reads when due (never a burst).
    await this.publishPrices(gen);
    if (!this.gone(gen) && this.roundTimer) this.schedule(gen);
  }

  onDeviceDeleted(device) {
    const key = parseDeviceId(device?.external_id);
    if (!key) return;
    for (const f of device.features ?? []) this.created.delete(f?.external_id);
    this.created.delete(device.external_id);
    this.pendingBackfill.delete(key);
  }

  /** The devices offered in Discovery: what was read, else what /data remembers. Never a request. */
  async publishDiscovery(gen, { onlyChanged = false } = {}) {
    if (!this.idKey) return;
    // What this process read first, then what /data remembers (a contract
    // missing from one answer stays offered).
    const devices = this.knownContracts().map((c) => buildContractDevice(this.gladys, c));
    const text = JSON.stringify(devices);
    if (onlyChanged && text === this.lastDiscovery) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      if (!this.gone(gen)) this.lastDiscovery = text;
    } catch (err) {
      this.log.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  async scan() {
    await this.publishDiscovery(this.gen);
  }

  /** Every contract known: this read and the ones /data keeps. */
  knownContracts() {
    const read = this.contracts ?? [];
    return [...read, ...this.data.contracts.filter((x) => !read.some((c) => c.key === x.key))];
  }

  /** The price kept for the quarter starting at `q`. */
  priceFor(key, q) {
    return this.data.prices[key]?.[Math.floor(q / QUARTER)];
  }

  /** The next change of price after the quarter `q` (within 2 days): { at, price }. */
  nextChange(key, q, price) {
    for (let at = q + QUARTER; at < q + 2 * DAY; at += QUARTER) {
      const p = this.priceFor(key, at);
      if (p === undefined) return { at, price: undefined };
      if (p !== price) return { at, price: p };
    }
    return undefined;
  }

  /** The price features of the created devices, from what is held (no request). */
  async publishPrices(gen) {
    if (this.gone(gen) || !this.idKey) return;
    const now = this.now();
    const mono = this.monotonic();
    const q = now - (now % QUARTER);
    const states = [];
    for (const c of this.knownContracts()) {
      const ids = idsOf(this.gladys, c.key);
      if (!c.dynamic || !this.created.has(ids.device)) continue;
      const price = this.priceFor(c.key, q);
      const next = price === undefined ? undefined : this.nextChange(c.key, q, price);
      const fees = this.fees.get(c.key);
      states.push(
        ...priceStates(ids, {
          price,
          // No change within 2 days: the same price; a next price unknown stays unknown.
          nextPrice: next ? next.price : price,
          monthlyFees: fees && mono - fees.mono <= FEES_MAX_AGE ? fees.value : undefined,
        }),
      );
    }
    if (!states.length) return;
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.log.warn(`States not published (${err?.name ?? 'Error'})`);
    }
  }

  // --- Energy contracts (delegated) ------------------------------------------------------

  /** The Ostrom contract of a Gladys contract: the one ending with the digits entered, else the only one. */
  contractOf(inputs) {
    const known = this.knownContracts();
    const raw = typeof inputs?.contract_suffix === 'string' ? inputs.contract_suffix.trim() : '';
    // Empty: the only contract; with several, never a guess.
    if (!raw) return known.length === 1 ? known[0] : undefined;
    if (!/^\d{1,4}$/.test(raw)) return undefined;
    const matches = known.filter((c) => c.suffix.endsWith(raw));
    // Two contracts ending alike: never a guess, the contract is not priced.
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * The cost of every interval (30 min): its kWh at the mean of its two
   * quarter prices, taxes, levies and VAT included; a negative price costs 0
   * (a cost is >= 0). One price unknown: the whole request fails (the core
   * retries later), never a silent zero. No request: what is held only.
   */
  energyPrice({ contract, intervals }) {
    const c = this.contractOf(contract?.inputs);
    if (!c) throw new Error('No Ostrom contract matches this energy contract');
    if (!c.dynamic) throw new Error('This Ostrom contract is not a dynamic tariff');
    return (intervals ?? []).map(({ starts_at: startsAt, kwh }) => {
      const t0 = Date.parse(startsAt);
      const p1 = Number.isFinite(t0) && t0 % QUARTER === 0 ? this.priceFor(c.key, t0) : undefined;
      const p2 = p1 === undefined ? undefined : this.priceFor(c.key, t0 + QUARTER);
      if (p1 === undefined || p2 === undefined || !finite(kwh) || kwh < 0) {
        throw new Error(`No Ostrom price known for ${String(startsAt).slice(0, 40)}`);
      }
      const cost = Math.max(0, (kwh * (p1 + p2)) / 2);
      return { starts_at: startsAt, cost: Math.round(cost * 1e8) / 1e8, label: 'SimplyDynamic' };
    });
  }

  energyCurrent({ contract }) {
    const c = this.contractOf(contract?.inputs);
    if (!c || !c.dynamic) return { price: null };
    const now = this.now();
    const q = now - (now % QUARTER);
    const price = this.priceFor(c.key, q);
    if (price === undefined) return { price: null };
    const next = this.nextChange(c.key, q, price);
    return {
      price,
      valid_until: next ? new Date(next.at).toISOString() : null,
      next_price: next?.price ?? null,
    };
  }

  // --- Status ------------------------------------------------------------------------

  async report(gen = this.gen) {
    if (this.gone(gen)) return;
    const [connected, message] = this.statusNow();
    if (this.storeState !== 'ok' && this.storeState !== 'pending') {
      for (const lang of ['en', 'fr']) message[lang] += t('storage', lang);
    }
    for (const lang of ['en', 'fr']) message[lang] = bound(message[lang].trim(), MAX_STATUS);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    await this.setStatus(connected, message, key);
  }

  async setStatus(connected, message, key = JSON.stringify([connected, message])) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.log.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  nextTime() {
    const wait = Math.max(0, (this.dueMono ?? this.monotonic()) - this.monotonic());
    // Rounded up: never a time before the read.
    return clock(this.now() + wait + 999);
  }

  statusNow() {
    if (this.config.problem) return [false, both(this.config.problem)];
    if (!this.idKey && this.idKeyFailures > 0) {
      const mono = this.monotonic();
      const wait = Math.max(0, (this.idKeyDue ?? mono) - mono, (this.dueMono ?? mono) - mono);
      return [false, both('idKeyNotStored', { time: clock(this.now() + wait + 999) })];
    }
    if (this.isRefused()) {
      return [false, both('refused', { code: this.refused.oauth ?? 'refused' })];
    }
    if (this.pauseActive()) {
      return [
        false,
        both(this.pause.code === 'rate_limited' ? 'rateLimited' : 'server', {
          time: clock(this.pause.until),
          code: this.pause.detail ?? this.pause.code,
        }),
      ];
    }
    if (!this.contracts) {
      return this.lastError
        ? [false, both('failing', { code: this.lastError, time: this.nextTime() })]
        : [false, both('starting', { time: this.nextTime() })];
    }
    if (!this.contracts.length) return [false, both('noContract')];
    const message = both('connected', {
      count: this.contracts.length,
      time: clock(this.contractsOkAt),
    });
    const add = (key, values) => {
      for (const lang of ['en', 'fr']) message[lang] += t(key, lang, values);
    };
    if (this.lastError) add('lastFailed', { code: this.lastError, time: this.nextTime() });
    if (this.pricesError) add('pricesFailed', { code: this.pricesError });
    if (this.zipUnknown) add('zipUnknown');
    // Said only while a hole is still there (filled, or out of the 31 days).
    if (this.pastMissing && this.firstHole(this.priceTargets(), this.now()) === undefined) {
      this.pastMissing = false;
    }
    if (this.pastMissing) add('pastMissing');
    if (this.contracts.some((c) => c.dynamic && !c.zip)) add('noZip');
    if (this.consumptionError) add('consumptionFailed', { code: this.consumptionError });
    return [!this.lastError, message];
  }

  // --- Test button ------------------------------------------------------------------------

  /** A token and the list of contracts: lifts a refusal on success. */
  async testConnection() {
    if (this.config.problem) return both(this.config.problem);
    const mono = this.monotonic();
    if (this.lastTest !== undefined && mono - this.lastTest < TEST_MIN_GAP)
      return both('testTooSoon');
    if (this.pauseActive(mono)) return both('testPaused', { time: clock(this.pause.until) });
    const session = this.session;
    if (!session) return both('missing');
    const gen = this.gen;
    this.lastTest = mono;
    let message;
    try {
      const body = await session.get('/contracts');
      if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
      const list = this.idKey ? parseContracts(body, this.idKey) : undefined;
      const count = list?.length ?? (Array.isArray(body?.data) ? body.data.length : 0);
      message = both('testOk', { count });
      await this.clearPause();
      if (this.refused) {
        // The credentials work: read soon (never sooner than a minute after the last read).
        this.refused = undefined;
        this.data.refused = null;
        this.freshConfig = true;
        this.failures = 0;
        await this.save();
      }
      if (!this.gone(gen)) this.schedule(gen);
    } catch (err) {
      if (this.gone(gen)) return both('testFailed', { code: 'restarted' });
      const code = err instanceof OstromError ? err.code : 'bad_response';
      if (code === 'refused') {
        await this.refuse(err);
        message = both('refused', { code: err.oauth ?? 'refused' });
      } else if (PAUSING.has(code)) {
        await this.setPause(err);
        message = both('testPaused', { time: clock(this.pause.until) });
      } else {
        message = both('testFailed', { code: codeOf(err) });
      }
    }
    await this.report(gen);
    return message;
  }
}
