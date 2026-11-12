// -----------------------------------------------------------------------------
// Runtime texts, English and French: device and feature names, the status of
// the configuration screen, the answers of the test button.
// -----------------------------------------------------------------------------

const TEXTS = {
  deviceContract: {
    en: 'Ostrom electricity (contract …{suffix})',
    fr: 'Ostrom électricité (contrat …{suffix})',
  },
  featurePrice: { en: 'Price per kWh now', fr: 'Prix du kWh actuel' },
  featureNextPrice: { en: 'Next price per kWh', fr: 'Prochain prix du kWh' },
  featureMonthlyFees: {
    en: 'Base fee and grid fees per month',
    fr: 'Frais de base et de réseau par mois',
  },
  featureConsumption: { en: 'Consumption (30 min)', fr: 'Consommation (30 min)' },

  // Status of the configuration screen.
  missing: {
    en: 'Enter the client id and client secret of your Ostrom API client (Ostrom Developer Portal).',
    fr: 'Saisissez l’identifiant client et le secret client de votre client d’API Ostrom (Ostrom Developer Portal).',
  },
  half: {
    en: 'Enter both the client id and the client secret: nothing is sent with one of them only.',
    fr: 'Saisissez l’identifiant client et le secret client : rien n’est envoyé avec un seul des deux.',
  },
  malformed: {
    en: 'The client id or the client secret is not valid (spaces or control characters, too long), or the environment is unknown: nothing sent.',
    fr: 'L’identifiant client ou le secret client n’est pas valide (espaces ou caractères de contrôle, trop long), ou l’environnement est inconnu : rien envoyé.',
  },
  configUnread: {
    en: 'The configuration could not be read from Gladys: tried again shortly.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai sous peu.',
  },
  idKeyNotStored: {
    en: 'Gladys did not store the key of the device ids: nothing read until it does (next try at {time}).',
    fr: 'Gladys n’a pas gardé la clé des identifiants d’appareils : rien n’est lu tant qu’elle ne l’a pas fait (prochain essai à {time}).',
  },
  refused: {
    en: 'Ostrom refused the client id or the client secret ({code}): nothing is sent until you change them or the Test button succeeds.',
    fr: 'Ostrom a refusé l’identifiant client ou le secret client ({code}) : rien n’est envoyé tant que vous ne les changez pas ou que le bouton Tester ne réussit pas.',
  },
  rateLimited: {
    en: 'Ostrom asked to slow down ({code}): no request until {time}.',
    fr: 'Ostrom a demandé de ralentir ({code}) : aucune requête avant {time}.',
  },
  server: {
    en: 'Ostrom is unavailable ({code}): no request until {time}.',
    fr: 'Ostrom est indisponible ({code}) : aucune requête avant {time}.',
  },
  starting: {
    en: 'Starting: first read at {time}.',
    fr: 'Démarrage : première lecture à {time}.',
  },
  failing: {
    en: 'Ostrom not read ({code}): next try at {time}.',
    fr: 'Ostrom non lu ({code}) : prochain essai à {time}.',
  },
  noContract: {
    en: 'Connected, but this API client sees no Ostrom contract.',
    fr: 'Connecté, mais ce client d’API ne voit aucun contrat Ostrom.',
  },
  connected: {
    en: 'Connected: {count} contract(s), read at {time}.',
    fr: 'Connecté : {count} contrat(s), lus à {time}.',
  },
  lastFailed: {
    en: ' Last read failed ({code}): next try at {time}.',
    fr: ' Dernière lecture en échec ({code}) : prochain essai à {time}.',
  },
  pricesFailed: {
    en: ' Prices not read ({code}).',
    fr: ' Prix non lus ({code}).',
  },
  zipUnknown: {
    en: ' Ostrom gave no taxes nor grid fees for the postcode of a contract: its prices are not kept (the contract is not priced).',
    fr: ' Ostrom n’a donné ni taxes ni frais de réseau pour le code postal d’un contrat : ses prix ne sont pas gardés (le contrat n’est pas tarifé).',
  },
  pastMissing: {
    en: ' Ostrom gave no price for some past days: the energy costs of their billing period stay empty (asked again every 6 hours).',
    fr: ' Ostrom n’a donné aucun prix pour certains jours passés : les coûts d’énergie de leur période de facturation restent vides (redemandés toutes les 6 heures).',
  },
  noZip: {
    en: ' A dynamic contract has no readable postcode: its prices cannot be read.',
    fr: ' Un contrat dynamique n’a pas de code postal lisible : ses prix ne peuvent pas être lus.',
  },
  consumptionFailed: {
    en: ' Consumption not read ({code}).',
    fr: ' Consommation non lue ({code}).',
  },
  storage: {
    en: ' /data cannot be read: nothing is kept across restarts until it can.',
    fr: ' /data illisible : rien n’est gardé d’un redémarrage à l’autre tant qu’il ne l’est pas.',
  },

  // Test button.
  testOk: {
    en: 'Connected to Ostrom: {count} contract(s) seen.',
    fr: 'Connecté à Ostrom : {count} contrat(s) vu(s).',
  },
  testTooSoon: {
    en: 'Not sent: one test a minute at most.',
    fr: 'Rien envoyé : un test par minute au plus.',
  },
  testPaused: {
    en: 'Not sent: Ostrom asked to wait until {time}.',
    fr: 'Rien envoyé : Ostrom a demandé d’attendre jusqu’à {time}.',
  },
  testFailed: {
    en: 'Ostrom could not be reached ({code}): nothing changed.',
    fr: 'Ostrom n’a pas pu être joint ({code}) : rien n’a changé.',
  },
};

/** A text in a language, with its {placeholders} filled. */
export function t(key, language = 'en', values = {}) {
  const entry = TEXTS[key];
  const text = entry?.[language] ?? entry?.en ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}

/** Both languages of a text: { en, fr }. */
export const both = (key, values) => ({ en: t(key, 'en', values), fr: t(key, 'fr', values) });

export const ALL_TEXTS = TEXTS;
