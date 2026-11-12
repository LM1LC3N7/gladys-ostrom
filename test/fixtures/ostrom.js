// -----------------------------------------------------------------------------
// Answers of the Ostrom API, shaped like the OpenAPI spec 2023-11-01
// (docs.ostrom-api.io). Made-up numbers: no real customer.
// -----------------------------------------------------------------------------

export const NOW = Date.parse('2026-11-11T10:00:00.000Z'); // 11:00 in Germany
export const CLIENT_ID = 'cid-0f9e8d7c6b5a4321';
export const CLIENT_SECRET = 'csec-S3cr3t-Value-0123456789';
export const CONTRACT_ID = 100523456;
export const ZIP = '10997';
export const ID_KEY = 'a1'.repeat(32);
export const QUARTER = 15 * 60 * 1000;
export const HOUR = 4 * QUARTER;

export const token = ({ life = 3599 } = {}) => ({
  access_token: `tok-${Math.random().toString(36).slice(2)}-abcdefghijklmnop`,
  token_type: 'Bearer',
  expires_in: life,
});

export const contract = (overrides = {}) => ({
  id: CONTRACT_ID,
  type: 'ELECTRICITY',
  productCode: 'SIMPLY_DYNAMIC',
  status: 'ACTIVE',
  customerFirstName: 'Erika',
  customerLastName: 'Mustermann',
  startDate: '2026-01-01T00:00:00.000Z',
  currentMonthlyDepositAmount: '62',
  address: { zip: ZIP, city: 'Berlin', street: 'Musterstraße', houseNumber: '1' },
  ...overrides,
});

export const contracts = (list = [contract()]) => ({ data: list });

/** The spot price (cents) of the quarter starting at `q`: 10 + the hour of the day. */
export const spotOf = (q) => 10 + new Date(q).getUTCHours();
export const TAXES = 19.28;
/** The gross price EUR/kWh of a quarter. */
export const priceOf = (q) => Math.round((spotOf(q) + TAXES) * 1e4) / 1e6;
export const FEES = 6 + 4.57;

export function spotPrices({ from, to, step = QUARTER, zip = true, spot = spotOf }) {
  const data = [];
  for (let q = from; q < to; q += step) {
    data.push({
      date: new Date(q).toISOString(),
      netMwhPrice: (spot(q) * 10) / 1.19,
      netKwhPrice: spot(q) / 1.19,
      grossKwhPrice: spot(q),
      netKwhTaxAndLevies: zip ? 16.2 : 0,
      grossKwhTaxAndLevies: zip ? TAXES : 0,
      netMonthlyOstromBaseFee: zip ? 5.04 : 0,
      grossMonthlyOstromBaseFee: zip ? 6 : 0,
      netMonthlyGridFees: zip ? 3.84 : 0,
      grossMonthlyGridFees: zip ? 4.57 : 0,
    });
  }
  return { data };
}

export const KWH = 0.48;

export function consumption({ from, to, kwh = () => KWH }) {
  const data = [];
  for (let h = from; h < to; h += HOUR) data.push({ date: new Date(h).toISOString(), kWh: kwh(h) });
  return { data };
}
