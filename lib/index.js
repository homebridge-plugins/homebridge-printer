import { PLATFORM_NAME, PLUGIN_NAME, PrinterPlatform } from './platform.js';

/**
 * @homebridge-plugins/homebridge-printer
 * Based on homebridge-printer by SeydX (https://github.com/seydx/homebridge-printer), MIT.
 * Rewritten for Homebridge 1.8+ and 2.x.
 */
export default (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PrinterPlatform);
};
