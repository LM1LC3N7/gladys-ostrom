// -----------------------------------------------------------------------------
// The Gladys devices (pure). Read-only features only: nothing is commanded.
//
// External ids (forever):
//   ext:<selector>:contract:<key>   an Ostrom electricity contract; key = 16 hex
//                                   digits of an HMAC-SHA-256 of the contract
//                                   number under the id key kept in the Gladys
//                                   config (the number itself is never in an
//                                   id, a log, a status or /data).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { MAX_MONTHLY_FEES, MAX_PRICE } from './constants.js';
import { t } from './i18n.js';

export const KIND = Object.freeze({ CONTRACT: 'contract' });
export const FEATURE = Object.freeze({
  PRICE: 'price',
  NEXT_PRICE: 'next_price',
  MONTHLY_FEES: 'monthly_fees',
  CONSUMPTION: 'consumption',
});

export const idsOf = (gladys, key) => gladys.externalIds(KIND.CONTRACT, key);

/** The key of one of our device external ids; undefined otherwise. */
export function parseDeviceId(externalId) {
  const match = /:contract:([0-9a-f]{16})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

const sensor = (ids, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(key),
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
  ...extra,
});

const money = (ids, key, name, min, max) =>
  sensor(ids, key, name, C.CURRENCY, T.CURRENCY.DECIMAL, { unit: U.EURO, min, max });

/** The device of a contract: `{ key, suffix, product, dynamic }`. */
export function buildContractDevice(gladys, contract, language = 'en') {
  const ids = idsOf(gladys, contract.key);
  const features = [];
  if (contract.dynamic) {
    features.push(
      money(ids, FEATURE.PRICE, t('featurePrice', language), -MAX_PRICE, MAX_PRICE),
      money(ids, FEATURE.NEXT_PRICE, t('featureNextPrice', language), -MAX_PRICE, MAX_PRICE),
      money(ids, FEATURE.MONTHLY_FEES, t('featureMonthlyFees', language), 0, MAX_MONTHLY_FEES),
    );
  }
  features.push(
    sensor(
      ids,
      FEATURE.CONSUMPTION,
      t('featureConsumption', language),
      C.ENERGY_SENSOR,
      T.ENERGY_SENSOR.THIRTY_MINUTES_CONSUMPTION,
      { unit: U.KILOWATT_HOUR, max: 500 },
    ),
  );
  return {
    name: t('deviceContract', language, { suffix: contract.suffix }),
    external_id: ids.device,
    features,
    params: [
      { name: 'contract_suffix', value: contract.suffix },
      { name: 'product', value: contract.product ?? '' },
    ],
  };
}

const round = (v) => Math.round(v * 1e6) / 1e6;

/** The price states of a contract device; a value unknown is left out (never 0). */
export function priceStates(ids, { price, nextPrice, monthlyFees }) {
  const out = [];
  const add = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ device_feature_external_id: ids.feature(key), state: round(value) });
    }
  };
  add(FEATURE.PRICE, price);
  add(FEATURE.NEXT_PRICE, nextPrice);
  add(FEATURE.MONTHLY_FEES, monthlyFees);
  return out;
}
