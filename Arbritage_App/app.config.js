// Load .env so EXPO_PUBLIC_* and other vars are available when Expo reads this file.
require('dotenv').config();

const { expo } = require('./app.json');

module.exports = {
  expo: {
    ...expo,
    extra: {
      kalshiApiKey: process.env.EXPO_PUBLIC_KALSHI_API_KEY || null,
      polymarketApiKey: process.env.EXPO_PUBLIC_POLYMARKET_API_KEY || null,
    },
  },
};
