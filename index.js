// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the HydroApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { HydroApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';
import { fileStorage } from './src/store.js';

const gladys = new GladysIntegration();
// The pauses (429), the instant of the last read, the last readings and what
// the scene triggers announced are kept in /data, the one writable volume, so
// that a restart loop never reads faster nor fires a trigger twice.
const app = new HydroApp({
  gladys,
  storage: fileStorage('/data/swiss-hydro-state.json', { logger }),
});

// --- Discovery: the stations already read (no extra call) --------------------
gladys.onScanRequest(() => app.publishDiscovered({ force: true }));

// --- A device was created: send its values now, not at the next reading ------
gladys.onDeviceCreated(() => app.publishStates());

// --- Configuration screen buttons ----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());
gladys.onAction(ACTIONS.SEARCH, (fields) => app.search(fields));

// --- Configuration changed by the user -----------------------------------------
gladys.onConfigUpdated(async (config) => {
  logger.info('Configuration updated: restarting');
  await app.start(config);
});

// --- Connection lifecycle -------------------------------------------------------
// A reconnection keeps the pauses, the last read and the trigger states; it
// publishes the status and the Discovery tab again (Gladys keeps them in
// memory only).
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error('Start failed', err);
  }
});
gladys.on('disconnected', () => app.stop());
gladys.handleShutdown(() => app.stop());

logger.info('Starting the Swiss hydrological data integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
