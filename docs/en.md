# Ostrom

Unofficial integration for **Ostrom** electricity customers in Germany, not
affiliated with Ostrom. It reads your own data through the official Ostrom
API. **Read-only**: nothing is ever changed on your account.

> This integration has never been tested with a real Ostrom account: it was
> written from the official API documentation. Please report what you see
> (GitHub issues of LM1LC3N7/gladys-ostrom).

## What you get

- **One device per Ostrom contract** (named "Ostrom electricity (contract
  …1234)", the last 4 digits of the contract number):
  - **Consumption (30 min)**: the smart-meter consumption, published after
    the fact for the Gladys energy monitoring. Ostrom gives hours: each hour is
    split in two equal halves. Only with a smart meter (iMSys) that sends its
    readings to Ostrom.
  - For a **SimplyDynamic** contract only: **Price per kWh now**, **Next price
    per kWh** (EUR/kWh, taxes, levies, variable grid fees and VAT included,
    every quarter of an hour) and **Base fee and grid fees per month** (EUR,
    VAT included).
- **The energy contract template "Ostrom SimplyDynamic"**: Gladys asks the
  integration the cost of every half hour; it answers with the mean of the two
  quarter-hour prices of your postcode times the consumption. A negative price
  costs 0 (Gladys accepts no negative cost). The monthly fees are a fixed
  amount you enter in the contract.

## Setting up

1. Log in to the **Ostrom Developer Portal** (https://developer.ostrom-api.io)
   with the account of your Ostrom app.
2. Create an **API client** for the **production** environment and accept the
   developer consent. Copy its **client id** and **client secret**.
3. In Gladys, open the integration's **Configuration**, paste both, keep
   **Environment: Production** and save. **Test the connection** gets a token
   and counts your contracts.
4. In **Discovery**, add the device of your contract.
5. For a SimplyDynamic contract: in the energy settings, create a contract
   from the **Ostrom SimplyDynamic** template, attached to that device's
   consumption. Leave "Last 4 digits of the Ostrom contract" empty when you
   have one contract; enter them when you have several. Enter the monthly fees
   shown by the "Base fee and grid fees per month" feature.

The client secret is kept by Gladys in its database, never shown again and sent
only to Ostrom to obtain an access token (valid one hour, held in memory only).
The **Sandbox** environment is only for an API client created for Ostrom's
sandbox (test data).

## How often it reads

- The contracts: every 6 hours.
- The prices: when the ones held do not cover the rest of today (or, from
  15:00 German time, when Ostrom loads them, the whole of tomorrow), at most
  once an hour. Once tomorrow is held, nothing until 15:00 the next day.
- The consumption of the devices you added: every 3 hours (the last 3 days),
  once a day after 06:00 and for a new device the last 7 days.
- After a failed read of the contracts: again after 5, 10, 20, 40, then every
  60 minutes. Ostrom asking to slow down (HTTP 429) or being unavailable
  (5xx): no request at all until the time asked (at least 1 minute, at most
  6 hours), kept across restarts.
- A restart, Discovery or saving the configuration never reads sooner than
  these intervals (new credentials are read after 1 minute).

## What the prices are

For each quarter of an hour, Ostrom's prices API gives, for your postcode, the
day-ahead spot price with VAT and the taxes, levies and variable grid fees with
VAT, in cents. The integration adds both and divides by 100. The prices of the
past quarters are kept 40 days in `/data`, so Gladys can price the past
intervals: create the contract from the day you install the integration.

Not included: a §14a variable grid fee (module 3), any discount or bonus of
your contract. A half hour whose two quarter prices are not both held is not
priced (Gladys tries again later): never a guessed or a zero price.

## Messages

- _Ostrom refused the client id or the client secret_: the token endpoint
  answered `invalid_client` or `unauthorized_client`. Nothing is sent again
  until you change the credentials or the **Test** button succeeds. Any other
  error (an unreadable answer, a 401 or 403 of a data request, a 5xx) is never
  taken as a refusal.
- _no taxes nor grid fees for the postcode_: Ostrom answered prices without
  taxes for the postcode of your contract; those prices are not yours and are
  not kept (asked again every 6 hours).
- _A dynamic contract has no readable postcode_: its prices cannot be read.

## Privacy

Your contract number, name, address and postcode are never written in a log,
the status or `/data`: a contract is known by a keyed hash and its last 4
digits. `/data` keeps the times of the last reads, the pause, the prices of
the past quarters and a marker of refused credentials (8 bits of a salted hash,
nothing to find them back from).
