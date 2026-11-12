// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Ostrom API (a fake fetch)
// and a virtual clock: nothing fires by itself, `wait(ms)` moves the clock and
// runs every timer due on the way, letting the promises they start settle.
// The monotonic clock moves by 1 µs at every read (a real one moves too).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OstromApp } from '../../src/app.js';
import { createMemoryStore } from '../../src/store.js';
import * as O from '../fixtures/ostrom.js';

export const SELECTOR = 'ostrom';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const CONFIG = { client_id: O.CLIENT_ID, client_secret: O.CLIENT_SECRET, id_key: O.ID_KEY };

/** The operation of a request. */
export function opOf(url) {
  const u = new URL(url);
  if (u.pathname === '/oauth2/token') return 'token';
  if (u.pathname === '/contracts') return 'contracts';
  if (u.pathname === '/spot-prices') return 'prices';
  if (/^\/contracts\/[^/]+\/energy-consumption$/.test(u.pathname)) return 'consumption';
  return 'unknown';
}

/** The default answers, by operation. */
export const defaults = {
  token: () => O.token(),
  contracts: () => O.contracts(),
  prices: ({ query }) =>
    O.spotPrices({ from: Date.parse(query.startDate), to: Date.parse(query.endDate) }),
  consumption: ({ query }, now) =>
    O.consumption({
      from: Date.parse(query.startDate),
      to: Math.min(Date.parse(query.endDate), now - (now % O.HOUR)),
    }),
};

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The Ostrom API: `answers[op](call, now)` -> a body object | a Response |
 * 'timeout' | 'network' | a promise of one of them. `calls` records every
 * request ({ op, query, auth, body, at }).
 */
export function createOstrom(answers = {}) {
  const api = { answers: { ...defaults, ...answers }, calls: [], clock: { now: O.NOW } };
  api.count = (op) => api.calls.filter((c) => c.op === op).length;
  api.fetch = async (url, init) => {
    const u = new URL(url);
    const call = {
      op: opOf(url),
      url,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      method: init.method,
      body: init.body,
      auth: init.headers.Authorization,
      headers: init.headers,
      signal: init.signal,
      at: api.clock.now,
    };
    api.calls.push(call);
    const answer = await api.answers[call.op]?.(call, api.clock.now);
    if (answer === 'timeout') {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer instanceof Response) return answer;
    if (answer === undefined) return json({ type: 'not_found', detail: 'no route' }, 404);
    return json(answer);
  };
  return api;
}

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
  };
  async function advance(ms) {
    const target = clock.now + ms;
    await settle();
    // A runaway schedule (a timer due at once, again and again) fails the
    // test instead of hanging it.
    for (let i = 0; ; i += 1) {
      if (i >= 5000) throw new Error('runaway timers: more than 5000 fired in one wait');
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
      }
      if (!next) break;
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      next.timer.fn();
      await settle();
    }
    clock.now = Math.max(clock.now, target);
    await settle();
  }
  return { clock, timers, pending, advance, settle };
}

export async function setup({
  devices: known = [],
  store = createMemoryStore(),
  now = O.NOW,
  ostrom = createOstrom(),
  config = CONFIG,
  wall = { offset: 0 },
  random,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  await gladys.connect();
  const { clock, timers, pending, advance, settle } = createFakeClock(now);
  ostrom.clock = clock;
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new OstromApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now + wall.offset,
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    fetchImpl: ostrom.fetch,
    requestGap: 0,
    ...(random ? { random } : {}),
  });
  const start = async (cfg = config) => {
    gladys.fake.config = cfg;
    const done = app.connected();
    await settle();
    await done;
    await advance(0);
  };
  return {
    app,
    gladys,
    fake: gladys.fake,
    clock,
    store,
    ostrom,
    start,
    wait: (ms) => advance(ms),
    settle,
    lines,
    pending,
  };
}

/** Everything the integration ever wrote out: logs, statuses, /data, Discovery, states. */
export function written(env) {
  return JSON.stringify([
    env.lines,
    env.fake.connectionStatuses,
    env.store.data,
    env.fake.discoveredDevices,
    env.fake.states,
    env.fake.publishedEnergyConsumption,
  ]);
}
