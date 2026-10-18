// -----------------------------------------------------------------------------
// The user-facing texts: the connection status and the action answers, in
// English and French.
// -----------------------------------------------------------------------------

const clockUtc = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

export const SOURCE_NAMES = {
  foen: { en: 'FOEN open data (LINDAS)', fr: 'données ouvertes OFEV (LINDAS)' },
  swisshydroapi: { en: 'swisshydroapi (Bouni)', fr: 'swisshydroapi (Bouni)' },
};

/** Why a read failed, by HydroError kind. */
export function reason(kind) {
  switch (kind) {
    case 'limited':
      return { en: 'too many requests, paused', fr: 'trop de requêtes, en pause' };
    case 'server':
      return { en: 'service unavailable', fr: 'service indisponible' };
    case 'not_found':
      return { en: 'unknown station', fr: 'station inconnue' };
    case 'answer':
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case 'missing':
      return { en: 'no data for this station', fr: 'aucune donnée pour cette station' };
    case 'http':
      return { en: 'refused by the service', fr: 'refusé par le service' };
    default:
      return { en: 'network error', fr: 'erreur réseau' };
  }
}

export const T = {
  noStation: {
    en: 'No station chosen: enter station numbers (or names) in the configuration. The "Search stations" button finds them.',
    fr: 'Aucune station choisie : saisissez des numéros (ou des noms) de stations dans la configuration. Le bouton « Chercher des stations » les trouve.',
  },
  paused: (until) => ({
    en: `The data service asked to slow down: paused until ${clockUtc(until)}.`,
    fr: `Le service de données a demandé de ralentir : en pause jusqu'à ${clockUtc(until)}.`,
  }),
  ok: ({ stations, interval, source, fresh }) => ({
    en: `${stations} station(s), ${fresh} with a current value, read every ${interval} min from the ${source.en}.`,
    fr: `${stations} station(s), dont ${fresh} avec une valeur actuelle, lues toutes les ${interval} min depuis les ${source.fr}.`,
  }),
  failed: (r) => ({
    en: `Last read failed (${r.en}); the last values are kept.`,
    fr: `La dernière lecture a échoué (${r.fr}) ; les dernières valeurs sont gardées.`,
  }),
  notFound: (n) => ({
    en: `${n} station(s) without data (unknown number, or out of service).`,
    fr: `${n} station(s) sans donnée (numéro inconnu, ou hors service).`,
  }),
  unresolved: (names) => ({
    en: `Not found or ambiguous, use the station number: ${names.join(', ')}.`,
    fr: `Introuvable ou ambigu, utilisez le numéro de la station : ${names.join(', ')}.`,
  }),
  tooMany: (max) => ({
    en: `Only the first ${max} stations are read.`,
    fr: `Seules les ${max} premières stations sont lues.`,
  }),
  unknownUnit: (n) => ({
    en: `${n} station(s) without the unit of their discharge yet: flow not published.`,
    fr: `${n} station(s) dont l'unité du débit est encore inconnue : débit non publié.`,
  }),
};
