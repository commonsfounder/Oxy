const SUPPORTED_ACTIONS = ['search_trains', 'station_board'];
const { getGoogleDirectionsKey } = require('../api/services/maps-config');

function getAxios() {
  return require('axios');
}

const CRS_MAP = {
  'apsley': 'APS', 'apsley station': 'APS',
  'birmingham': 'BHM', 'birmingham new street': 'BHM',
  'london euston': 'EUS', 'euston': 'EUS',
  'london paddington': 'PAD', 'paddington': 'PAD',
  'london waterloo': 'WAT', 'waterloo': 'WAT',
  'london victoria': 'VIC', 'victoria': 'VIC',
  "london king's cross": 'KGX', 'kings cross': 'KGX',
  'london st pancras': 'STP', 'st pancras': 'STP',
  'manchester': 'MAN', 'manchester piccadilly': 'MAN',
  'liverpool': 'LIV', 'liverpool lime street': 'LIV',
  'leeds': 'LDS', 'sheffield': 'SHF', 'nottingham': 'NOT',
  'leicester': 'LEI', 'coventry': 'COV', 'wolverhampton': 'WVH',
  'milton keynes': 'MKC', 'milton keynes central': 'MKC', 'mk central': 'MKC',
  'bristol': 'BRI', 'bristol temple meads': 'BRI',
  'cardiff': 'CDF', 'cardiff central': 'CDF',
  'edinburgh': 'EDB', 'edinburgh waverley': 'EDB',
  'glasgow': 'GLC', 'glasgow central': 'GLC',
  'newcastle': 'NCL', 'york': 'YRK', 'cambridge': 'CBG',
  'oxford': 'OXF', 'reading': 'RDG', 'brighton': 'BTN',
  'southampton': 'SOT', 'norwich': 'NRW', 'exeter': 'EXD',
  'plymouth': 'PLY', 'aberdeen': 'ABD',
  'hemel hempstead': 'HML',
  'watford junction': 'WFJ', 'watford': 'WFJ',
  'berkhamsted': 'BKM',
  'tring': 'TRI',
};

function normalizeStationName(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bstation\b/g, ' ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toCRS(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  return CRS_MAP[normalizeStationName(s)] || null;
}

async function lookupCRS(name) {
  // Fast path — hardcoded common stations
  const local = toCRS(name);
  if (local) return local;
  return null;
}

async function getNextTrains(originCRS, destCRS) {
  const appId  = process.env.TRANSPORT_API_APP_ID;
  const appKey = process.env.TRANSPORT_API_APP_KEY;
  const endpoint = `https://transportapi.com/v3/uk/train/station/${originCRS}/live.json`;
  const baseParams = {
    app_id: appId,
    app_key: appKey,
    calling_at: destCRS,
    train_status: 'passenger',
  };

  let resp;
  const axios = getAxios();
  try {
    resp = await axios.get(endpoint, {
      params: { ...baseParams, darwin: true },
      timeout: 10000,
    });
  } catch (err) {
    // Some TransportAPI apps can access live rail data but not the Darwin-specific flag.
    // Retry the plain live endpoint before surfacing a failure.
    if (err.response?.status !== 403) throw err;
    try {
      resp = await axios.get(endpoint, {
        params: baseParams,
        timeout: 10000,
      });
    } catch (fallbackErr) {
      if (fallbackErr.response?.status === 403) {
        return { trains: [], accessDenied: true };
      }
      throw fallbackErr;
    }
  }

  const departures = resp.data?.departures?.all || [];
  return {
    accessDenied: false,
    trains: departures.slice(0, 3).map(d => ({
    scheduledDeparture: d.aimed_departure_time,
    estimatedDeparture: d.expected_departure_time,
    scheduledArrival:   d.aimed_arrival_time,
    estimatedArrival:   d.expected_arrival_time,
    platform:           d.platform,
    destination:        d.destination_name,
    operator:           d.operator_name,
    cancelled:          d.status === 'CANCELLED',
    }))
  };
}

async function getStationBoard(stationCRS) {
  const appId = process.env.TRANSPORT_API_APP_ID;
  const appKey = process.env.TRANSPORT_API_APP_KEY;
  const endpoint = `https://transportapi.com/v3/uk/train/station/${stationCRS}/live.json`;
  const axios = getAxios();
  try {
    const resp = await axios.get(endpoint, {
      params: {
        app_id: appId,
        app_key: appKey,
        train_status: 'passenger'
      },
      timeout: 10000
    });
    const departures = resp.data?.departures?.all || [];
    return {
      accessDenied: false,
      trains: departures.slice(0, 5).map(d => ({
        scheduledDeparture: d.aimed_departure_time,
        estimatedDeparture: d.expected_departure_time,
        platform: d.platform,
        destination: d.destination_name,
        operator: d.operator_name,
        cancelled: d.status === 'CANCELLED',
      }))
    };
  } catch (err) {
    if (err.response?.status === 403) return { trains: [], accessDenied: true };
    throw err;
  }
}

// CRS → Trainline city slug for route URLs (thetrainline.com/trains/{from}/{to})
const CITY_SLUG = {
  'EUS': 'london', 'PAD': 'london', 'WAT': 'london', 'VIC': 'london',
  'KGX': 'london', 'STP': 'london', 'CST': 'london', 'MOG': 'london',
  'BHM': 'birmingham',
  'MAN': 'manchester',
  'LIV': 'liverpool',
  'LDS': 'leeds',
  'SHF': 'sheffield',
  'NOT': 'nottingham',
  'LEI': 'leicester',
  'COV': 'coventry',
  'WVH': 'wolverhampton',
  'MKC': 'milton-keynes',
  'BRI': 'bristol',
  'CDF': 'cardiff',
  'EDB': 'edinburgh',
  'GLC': 'glasgow',
  'NCL': 'newcastle',
  'YRK': 'york',
  'CBG': 'cambridge',
  'OXF': 'oxford',
  'RDG': 'reading',
  'BTN': 'brighton',
  'SOT': 'southampton',
  'NRW': 'norwich',
  'EXD': 'exeter',
  'PLY': 'plymouth',
  'ABD': 'aberdeen',
};

function buildTrainlineURL(originCRS, destCRS) {
  const from = CITY_SLUG[originCRS] || originCRS.toLowerCase();
  const to   = CITY_SLUG[destCRS]   || destCRS.toLowerCase();
  return `https://www.thetrainline.com/trains/${from}/${to}`;
}

function slugifyStation(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function buildTrainlineFallbackURL(origin, destination) {
  const from = slugifyStation(origin);
  const to = slugifyStation(destination);
  if (from && to) return `https://www.thetrainline.com/trains/${from}/${to}`;
  return 'https://www.thetrainline.com/';
}

function compareClockTimes(a, b) {
  if (!a || !b || !/^\d{2}:\d{2}$/.test(a) || !/^\d{2}:\d{2}$/.test(b)) return null;
  return a.localeCompare(b);
}

async function execute(userId, action, params) {
  try {
    if (action === 'station_board') {
      const station = String(params?.station || params?.origin || '').trim();
      if (!station) return { success: false, error: 'station_board requires a station' };
      return {
        success: true,
        text: `I can't give a reliable live station board for ${station} yet because the TransportAPI rail feed is disabled. Ask for a train route with an origin and destination and I'll return the best itinerary I can from route data.`,
        trains: [],
        cardText: 'Live station board unavailable',
        actionSummary: 'Live rail unavailable'
      };
    }

    if (action !== 'search_trains') return { success: false, error: `Unknown action: ${action}` };

    const { origin, destination } = params;
    if (!origin || !destination) return { success: false, error: 'search_trains requires origin and destination' };

    if (!getGoogleDirectionsKey()) {
      return {
        success: true,
        text: `I couldn't get a train route summary from ${origin} to ${destination} because route data is not configured on the server.`,
        cardText: 'No train route summary available',
        actionSummary: 'Route unavailable',
        trains: [],
        transportApiDisabled: true,
        routeContext: {
          origin,
          destination,
          mode: 'rail',
          reason: 'google_directions_key_missing'
        }
      };
    }

    const maps = require('./maps');
    const planned = await maps.execute(userId, 'plan_trip', {
      ...params,
      origin,
      destination,
      preference: params?.preference || 'fastest'
    });
    return {
      ...planned,
      actionSummary: planned?.actionSummary === 'Route unavailable' ? 'Route unavailable' : 'Train route checked',
      cardText: planned?.cardText || 'Train route checked',
      trains: [],
      transportApiDisabled: true
    };
  } catch (err) {
    return { success: false, error: `Trainline error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
