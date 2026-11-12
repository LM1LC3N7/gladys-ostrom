# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads **Ostrom** (Germany) through the official Ostrom API
(`production.ostrom-api.io`, OAuth2 client credentials at
`auth.production.ostrom-api.io/oauth2/token`; sandbox hosts alike): the
customer's contracts (`/contracts`), the smart-meter consumption by hour
(`/contracts/{id}/energy-consumption`) and the quarter-hour prices of the
contract's postcode (`/spot-prices`). **Read-only.** Unofficial: not
affiliated with Ostrom. Written from the official docs and OpenAPI spec only.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/model.test.js            # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run mutants                           # mutation check (run under memcap, one at a time)
```

## Architecture

```
index.js                 SDK wiring only
src/handlers.js          every handler registered before connect() (shared with the tests)
src/app.js               OstromApp: pace, pauses, refusal, /data, Discovery, prices, pricing, status
src/ostrom/client.js     the only network code: token, GET, bounded bodies, one request at a time
src/ostrom/model.js      reading the answers (pure): contracts, prices, consumption
src/devices.js           the Gladys devices (pure), external ids
src/store.js             /data/ostrom.json (atomic writes, unreadable != empty)
src/time.js              German local time (Intl)
src/i18n.js              runtime texts, en + fr
test/                    node --test against the SDK's fake Gladys and a fake Ostrom API
```

## Rules

- **External ids are forever**: `ext:ostrom:contract:<hmac>` and its feature
  keys `price`, `next_price`, `monthly_fees`, `consumption`; the template key
  `ostrom-simply-dynamic` and its inputs `contract_suffix`, `monthly_fees`.
- **No secret anywhere**: the client secret, the token, the contract number,
  the customer's name, address and postcode never reach a log, the status,
  `/data` nor an error message.
- **Never a guessed value**: an unreadable price or consumption is unknown,
  never 0; a delegated interval without both quarter prices fails the request.
- **Only `invalid_client` / `unauthorized_client` of the token endpoint is a
  refusal**; everything else is passing.
- **Two clocks**: the monotonic clock paces and pauses; the wall clock dates
  prices, consumption and what `/data` keeps.
- **Versions belong to the Release workflow.** Changelog lines under
  `## [Unreleased]`. Texts bilingual (en, fr), docs/en.md and docs/fr.md in
  sync with the code. A secret field is described as kept by Gladys, never shown again.
