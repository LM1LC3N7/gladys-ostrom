// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, setTimeout) and a real local
// HTTP server playing the Ostrom API and its token endpoint: the contracts are
// really read at 0, the interval and twice the interval, with a bounded number
// of timers, and nothing is sent after stop(). The time is sped up 10000 times
// (6 hours last 2.2 s) but it is the real clock: it moves between any two reads.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OstromApp } from '../src/app.js';
import { CONTRACTS_INTERVAL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { defaults, opOf } from './helpers/app.js';
import * as O from './fixtures/ostrom.js';

const SPEED = 10_000;

test('real clock: contracts read at 0, the interval and twice the interval; timers bounded', async (t) => {
  const reads = [];
  let requests = 0;
  let t0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      const url = `http://x${req.url}`;
      const op = opOf(url);
      if (op === 'contracts') reads.push(performance.now() * SPEED);
      const query = Object.fromEntries(new URL(url).searchParams);
      const now = O.NOW + (performance.now() - t0) * SPEED;
      // A token for 10 hours: the renewal is another test's business.
      const answer = op === 'token' ? O.token({ life: 36000 }) : defaults[op]({ query }, now);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({
    selector: 'ostrom',
    config: { client_id: O.CLIENT_ID, client_secret: O.CLIENT_SECRET, id_key: O.ID_KEY },
  });
  await gladys.connect();
  const quiet = () => {};
  const base = `http://127.0.0.1:${server.address().port}`;
  t0 = performance.now();
  const app = new OstromApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => O.NOW + (performance.now() - t0) * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    urls: { api: base, auth: `${base}/oauth2/token` },
  });
  // Stopped even when an assertion fails: no timer left behind.
  t.after(() => app.stop());
  const started = performance.now() * SPEED;
  await app.connected();
  const deadline = performance.now() + 20_000;
  const until = started + 2.5 * CONTRACTS_INTERVAL;
  while (performance.now() * SPEED < until && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.stop();
  const sent = requests;
  await new Promise((resolve) => setTimeout(resolve, CONTRACTS_INTERVAL / SPEED));
  assert.equal(requests, sent, 'nothing sent after stop()');
  const at = reads.map((x) => Math.round((x - started) / 60_000));
  assert.equal(reads.length, 3, `reads at ${at} min`);
  assert.ok(reads[0] - started < CONTRACTS_INTERVAL / 4, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.9 * CONTRACTS_INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * CONTRACTS_INTERVAL, `on time: ${at}`);
  }
  // Ticks every quarter (60 in 15 h), the reads, the gaps, /data: bounded.
  assert.ok(timersSet <= 250, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
