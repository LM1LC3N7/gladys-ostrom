# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real Ostrom account: token, Discovery,
      the 7-day consumption backfill, the price features over a day, a
      SimplyDynamic contract priced.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).
- [ ] Store keywords left out of the manifest on purpose (Louis' rule):
      `ostrom`, `SimplyDynamic`, `dynamischer Stromtarif`.

## To confirm on a real account (built from the documentation only)

- [ ] The `productCode` / `type` of a SimplyDynamic contract: taken as dynamic
      when either contains "dynamic" (the sandbox test accounts are called
      "DynamicTariff" and "SimplyTariff"). A fixed-price contract has no price
      feature and is never priced.
- [ ] The token endpoint answers a wrong client with `invalid_client` (HTTP
      400 or 401, as OAuth2 says): the only refusal.
- [ ] `GET /spot-prices?resolution=QUARTER_HOUR` for days already past (up
      to 31 days back, by windows of 20 days, to fill the quarters missed
      during a stop), and how far ahead tomorrow comes (15:00 to 17:00 CET
      according to the docs).
- [ ] Does Ostrom credit a negative price? The module counts 0 for a half
      hour whose mean price is negative (the core refuses a negative cost):
      the Gladys cost is then above the bill.
- [ ] `grossKwhPrice + grossKwhTaxAndLevies` is what Ostrom bills per kWh of a
      SimplyDynamic contract (no other per-kWh margin), and the monthly fees
      are `grossMonthlyOstromBaseFee + grossMonthlyGridFees`.
- [ ] `GET /contracts/{id}/energy-consumption` with `resolution=HOUR` over 7
      days: one request accepted, hours of the smart meter in kWh, the date
      being the start of the hour (UTC). A contract without smart meter: an
      empty list or a 404 (both handled).
- [ ] The rate limits of the API (none published): one request at a time,
      2 s apart, about 10 requests a day in normal use.

## Decisions

- **Version 0.1.0** set by hand (package, lock, manifest, image tag) when
  leaving the template; the Release workflow owns it from now on.
- **`gladys_version: ">=5.3.0"`** with `countries: ["DE"]` (Louis' rule of
  2026-11-12: `countries` needs 5.3.0); `publishEnergyConsumption` and the
  energy contracts need 5.2.0 anyway.
- **Read-only (v1)**: only GET requests and the token request.
- **One delegated template, no calendar.** The price per kWh depends on the
  customer's postcode (taxes, levies and grid fees): a shared calendar key
  (global, provider-neutral) could not carry it, and the market spot price
  calendar `spot-de` belongs to another integration (Gladys-EPEX-Spot); a
  rules template on `spot-de` would need the taxes of every postcode. The
  monthly fees are a `fixed` component fed by a template input (Gladys
  computes it); the feature shows the value read.
- **Prices**: gross, VAT included, cents / 100. A half hour is priced at the
  mean of its two quarters (the core sends 30-minute intervals); a negative
  mean of a half hour costs 0; an unknown price fails the whole request of
  its billing period (never a silent zero), so the past quarters without a
  price (31 days back, the core's catch-up window) are read again at most
  every 6 hours, by windows of 20 days. An
  hourly answer prices its four quarters. A quarter already started keeps the
  price first kept for it (a retry gets the same answer). Prices kept 40 days
  in `/data`, by contract.
- **Postcode check**: an answer where no item has taxes nor grid fees (what
  the API answers without a postcode it knows) is never kept, and asked
  again every 6 hours.
- **External ids**: `contract:<16 hex of an HMAC-SHA-256 of the contract
number>`, under a random 32-byte key made at the first start and stored with
  `setConfig` as `id_key` (outside the form, never in `/data`). Nothing is read
  nor published until the key is stored. The contract number, the customer's
  name, address and postcode stay in memory.
- **Refusal**: only a readable `invalid_client` / `unauthorized_client` of
  the token endpoint (400/401); persisted as 8 bits of a salted hash; no
  request until the credentials change or Test succeeds. A 401 of the API: one
  new token, one new try, then a passing error. A 403 anywhere, an unreadable
  answer: passing.
- **Token** in memory only; renewed 5 minutes before its end (`expires_in`,
  counted from the moment the request was sent).
- **Pace**: contracts every 6 h; prices when the held ones do not reach the
  end of today (or of tomorrow from 15:00), at most hourly, else nothing
  until the next 15:00; consumption every 3 h (3 days; 7 days daily after
  06:00 and for a new device, at least 1 minute after another read). 429:
  `Retry-After` or 15 min doubled; 5xx: 5 min doubled; at most 6 h,
  persisted.
- **Sandbox**: an environment select (production by default); the sandbox
  test accounts of the docs are for partner account linking, not for a
  customer API client, so the integration could not be tried there.
