# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: Ostrom contracts read through the official Ostrom API
  (OAuth2 client credentials of the customer's own API client, production or
  sandbox), one device per contract with the smart-meter consumption by half
  hour (published after the fact) and, for a SimplyDynamic contract, the
  price per kWh now and next and the monthly base and grid fees.
- The delegated energy contract template "Ostrom SimplyDynamic": every half
  hour priced from the quarter-hour prices of the contract's postcode, kept
  40 days in `/data`.
- Test button, refused credentials kept (never sent again until changed or
  Test succeeds), pauses on 429 and 5xx kept across restarts.
- The manifest declares `countries: ["DE"]` (the store shows the integration
  for Germany), which needs Gladys 5.3.0 or later.
- Past quarters without a price (Gladys stopped, Ostrom unavailable) are read
  again, up to 31 days back, at most every 6 hours.
