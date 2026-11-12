# Ostrom for Gladys Assistant

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**Ostrom** electricity customers in Germany, not affiliated with Ostrom. It
reads your own data through the official Ostrom API
([docs.ostrom-api.io](https://docs.ostrom-api.io)) with an API client you
create in the Ostrom Developer Portal (OAuth2 client credentials):

- one device per Ostrom contract: smart-meter consumption by half hour (the
  API gives hours, each split in two halves) for the energy monitoring and,
  for a **SimplyDynamic** contract, the price per kWh now and next and the
  monthly base and grid fees of your postcode;
- the energy contract template **Ostrom SimplyDynamic**, priced by the
  integration from the quarter-hour prices of your postcode (day-ahead spot
  price, taxes, levies and variable grid fees, VAT included).

**Read-only**: nothing is ever changed on your account. Never tested with a
real Ostrom account yet.

Documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
npm run mutants     # mutation check of the guards (scripts/mutants.json)
npm run cover       # regenerates cover.png
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md).
Open points and decisions: [TODO.md](TODO.md).

## Credits and license

Apache-2.0 ([LICENSE](LICENSE)). Written from the official Ostrom API
documentation and OpenAPI specification only, no third-party code: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
