const SUPPORTED_ACTIONS = ['search_trains', 'station_board'];

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

  // Fallback — TransportAPI station search
  if (!process.env.TRANSPORT_API_APP_ID || !process.env.TRANSPORT_API_APP_KEY) return null;
  try {
    const axios = getAxios();
    const resp = await axios.get('https://transportapi.com/v3/uk/places.json', {
      params: {
        query: name,
        type: 'train_station',
        app_id: process.env.TRANSPORT_API_APP_ID,
        app_key: process.env.TRANSPORT_API_APP_KEY,
      },
      timeout: 5000,
    });
    const match = resp.data?.results?.[0];
    return match?.station_code || null;
  } catch {
    return null;
  }
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

      const stationCRS = await lookupCRS(station);
      const bookingUrl = stationCRS
        ? `https://www.thetrainline.com/stations/${stationCRS.toLowerCase()}`
        : `https://www.thetrainline.com/search?origin=${encodeURIComponent(station)}`;

      if (!stationCRS) {
        return {
          success: true,
          text: `I couldn't verify "${station}" as a rail station for live departures, but I can open Trainline so you can confirm it there.`,
          cardText: 'Open station in Trainline',
          actionSummary: 'Trainline ready',
          webLink: bookingUrl,
          bookingUrl,
          trains: []
        };
      }

      if (!process.env.TRANSPORT_API_APP_ID || !process.env.TRANSPORT_API_APP_KEY) {
        return {
          success: true,
          text: `I couldn't check the live station board for ${station} because live rail data isn't configured right now. I can still open Trainline for the station.`,
          cardText: 'Open station in Trainline',
          actionSummary: 'Trainline ready',
          webLink: bookingUrl,
          bookingUrl,
          trains: []
        };
      }

      const { trains, accessDenied } = await getStationBoard(stationCRS);
      if (accessDenied) {
        return {
          success: true,
          text: `I couldn't access the live station board for ${station} with the current rail data permissions, but I can open Trainline for you.`,
          cardText: 'Open station in Trainline',
          actionSummary: 'Trainline ready',
          webLink: bookingUrl,
          bookingUrl,
          trains: []
        };
      }

      if (!trains.length) {
        return {
          success: true,
          text: `I couldn't find any live departures at ${station} in the current feed. I've included Trainline to double-check.`,
          cardText: 'Open station in Trainline',
          actionSummary: 'Trainline ready',
          webLink: bookingUrl,
          bookingUrl,
          trains: []
        };
      }

      const lines = trains.map((t, i) => {
        const dep = t.estimatedDeparture && t.estimatedDeparture !== 'On time'
          ? `${t.scheduledDeparture} (exp ${t.estimatedDeparture})`
          : t.scheduledDeparture;
        const plat = t.platform ? ` · Platform ${t.platform}` : '';
        const status = t.cancelled ? ' · CANCELLED' : '';
        return `${i + 1}. ${dep} to ${t.destination || 'destination TBC'}${plat}${status}`;
      });

      return {
        success: true,
        text: `Live departures at ${station}:\n${lines.join('\n')}`,
        trains,
        cardText: lines[0].replace(/^1\.\s*/, ''),
        actionSummary: 'Station board ready',
        webLink: bookingUrl,
        bookingUrl
      };
    }

    if (action !== 'search_trains') return { success: false, error: `Unknown action: ${action}` };

    const { origin, destination } = params;
    if (!origin || !destination) return { success: false, error: 'search_trains requires origin and destination' };

    const [originCRS, destCRS] = await Promise.all([lookupCRS(origin), lookupCRS(destination)]);

    if (!originCRS || !destCRS) {
      const missing = !originCRS ? origin : destination;
      const bookingUrl = buildTrainlineFallbackURL(origin, destination);
      return {
        success: true,
        text: `I couldn't verify "${missing}" as a rail station for live departures, but I can open the route in Trainline so you can confirm it there.`,
        cardText: 'Open route in Trainline',
        actionSummary: 'Trainline ready',
        webLink: bookingUrl,
        bookingUrl,
        trains: []
      };
    }

    const bookingUrl = buildTrainlineURL(originCRS, destCRS);

    if (!process.env.TRANSPORT_API_APP_ID || !process.env.TRANSPORT_API_APP_KEY) {
      return {
        success: true,
        text: `I couldn't check live departures for ${origin} to ${destination} because live rail data isn't configured right now. I can still open Trainline for the route.`,
        cardText: 'Open route in Trainline',
        webLink: bookingUrl,
        bookingUrl
      };
    }

    const { trains, accessDenied } = await getNextTrains(originCRS, destCRS);

    if (accessDenied) {
      return {
        success: true,
        text: `I couldn't access live departures for ${origin} to ${destination} with the current rail data permissions, but I can open the route in Trainline for you.`,
        cardText: 'Open route in Trainline',
        webLink: bookingUrl,
        bookingUrl,
        trains: []
      };
    }

    if (!trains.length) {
      return {
        success: true,
        text: `I couldn't find any matching live departures from ${origin} to ${destination} in the current feed. That doesn't necessarily mean there are no trains at all, so I've included Trainline to double-check.`,
        cardText: 'Open route in Trainline',
        webLink: bookingUrl,
        bookingUrl
      };
    }

    const lines = trains.map((t, i) => {
      const dep = t.estimatedDeparture && t.estimatedDeparture !== 'On time'
        ? `${t.scheduledDeparture} (exp ${t.estimatedDeparture})` : t.scheduledDeparture;
      const rawArr = t.estimatedArrival || t.scheduledArrival || '';
      const depCompareValue = t.estimatedDeparture && t.estimatedDeparture !== 'On time'
        ? t.estimatedDeparture
        : t.scheduledDeparture;
      const arr = compareClockTimes(rawArr, depCompareValue) === -1 ? '' : rawArr;
      const plat = t.platform ? ` · Platform ${t.platform}` : '';
      const status = t.cancelled ? ' ✗ CANCELLED' : '';
      const arrivalPart = arr ? ` → ${arr}` : '';
      return `${i + 1}. ${dep}${arrivalPart}${plat}${status}`;
    });

    return {
      success: true,
      text: `Next trains from ${origin} to ${destination}:\n${lines.join('\n')}`,
      trains,
      cardText: 'Open route in Trainline',
      webLink: bookingUrl,
      bookingUrl,
    };
  } catch (err) {
    return { success: false, error: `Trainline error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
