// -----------------------------------------------------------------------------
// The configuration of the form, normalized: the client id and client secret
// of the Ostrom API client the customer created in the Ostrom Developer Portal,
// and the environment they belong to. Nothing here talks to the network.
// -----------------------------------------------------------------------------

import { ENVIRONMENTS } from './constants.js';

/** Printable ASCII without space: never a control character (CR, LF, tab) in a credential. */
const CREDENTIAL = /^[\x21-\x7e]+$/;

const text = (value, max) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= max && CREDENTIAL.test(trimmed) ? trimmed : undefined;
};

/**
 * `{ clientId, clientSecret, environment, problem }`: `problem` names what
 * keeps the integration from logging in (nothing is sent then).
 */
export function normalizeConfig(raw = {}) {
  const clientId = text(raw?.client_id, 200);
  const clientSecret = text(raw?.client_secret, 500);
  const env = raw?.environment || 'production';
  const config = {
    clientId: clientId ?? '',
    clientSecret: clientSecret ?? '',
    environment: Object.hasOwn(ENVIRONMENTS, env) ? env : 'production',
    problem: undefined,
  };
  if (clientId === undefined || clientSecret === undefined || !Object.hasOwn(ENVIRONMENTS, env)) {
    config.problem = 'malformed';
  } else if (!config.clientId && !config.clientSecret) {
    config.problem = 'missing';
  } else if (!config.clientId || !config.clientSecret) {
    // A secret without its client id (or the reverse) is never sent.
    config.problem = 'half';
  }
  return config;
}

/** The credentials sent to the token endpoint, with the environment they belong to. */
export const credentialsOf = (config) => ({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  environment: config.environment,
});
