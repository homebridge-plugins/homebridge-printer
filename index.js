'use strict';

const { HPPrinterPlatform, PLUGIN_NAME, PLATFORM_NAME } = require('./src/platform');

/**
 * homebridge-hp-printer
 * Based on homebridge-printer by SeydX (https://github.com/seydx/homebridge-printer), MIT.
 * Rewritten for Homebridge 1.8+ and 2.x.
 */
module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HPPrinterPlatform);
};
