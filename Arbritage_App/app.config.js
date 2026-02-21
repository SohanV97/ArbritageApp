// Load .env from this directory so API keys are available regardless of cwd.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { expo } = require('./app.json');

// API keys: set EXPO_PUBLIC_KALSHI_API_KEY and EXPO_PUBLIC_POLYMARKET_API_KEY in Arbritage_App/.env
// They are read at runtime via Constants.expoConfig.extra in api/kalshi.ts and api/polymarket.ts
module.exports = {
  expo: {
    ...expo,
    extra: {
      kalshiApiKey: process.env.EXPO_PUBLIC_KALSHI_API_KEY || null,
      polymarketApiKey: process.env.EXPO_PUBLIC_POLYMARKET_API_KEY || null,
    },
  },
};
