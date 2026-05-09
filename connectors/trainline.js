const axios = require('axios');

const SUPPORTED_ACTIONS = ['search_trains'];

const CRS_MAP = {
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
  'bristol': 'BRI', 'bristol temple meads': 'BRI',
  'cardiff': 'CDF', 'cardiff central': 'CDF',
  'edinburgh': 'EDB', 'edinburgh waverley': 'EDB',
  'glasgow': 'GLC', 'glasgow central': 'GLC',
  'newcastle': 'NCL', 'york': 'YRK', 'cambridge': 'CBG',
  'oxford': 'OXF', 'reading': 'RDG', 'brighton': 'BTN',
  'southampton': 'SOT', 'norwich': 'NRW', 'exeter': 'EXD',
  'plymouth': 'PLY', 'aberdeen': 'ABD',
};

function toCRS(input) {
  const s = input.trim();
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  return CRS_MAP[s.toLowerCase()] || null;
}

async function lookupCRS(name) {
  // Fast path — hardcoded common stations
  const local = toCRS(name);
  if (local) return local;

  // Fallback — TransportAPI station search
  if (!process.env.TRANSPORT_API_APP_ID || !process.env.TRANSPORT_API_APP_KEY) return null;
  try {
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

  const resp = await axios.get(
    `https://transportapi.com/v3/uk/train/station/${originCRS}/live.json`,
    {
      params: {
        app_id: appId,
        app_key: appKey,
        calling_at: destCRS,
        darwin: true,
        train_status: 'passenger',
      },
      timeout: 10000,
    }
  );

  const departures = resp.data?.departures?.all || [];
  return departures.slice(0, 3).map(d => ({
    scheduledDeparture: d.aimed_departure_time,
    estimatedDeparture: d.expected_departure_time,
    scheduledArrival:   d.aimed_arrival_time,
    estimatedArrival:   d.expected_arrival_time,
    platform:           d.platform,
    destination:        d.destination_name,
    operator:           d.operator_name,
    cancelled:          d.status === 'CANCELLED',
  }));
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

async function execute(userId, action, params) {
  try {
    if (action !== 'search_trains') return { success: false, error: `Unknown action: ${action}` };

    const { origin, destination } = params;
    if (!origin || !destination) return { success: false, error: 'search_trains requires origin and destination' };

    const [originCRS, destCRS] = await Promise.all([lookupCRS(origin), lookupCRS(destination)]);

    if (!originCRS) return { success: false, error: `Unknown station: "${origin}". Try a different spelling or 3-letter CRS code.` };
    if (!destCRS)   return { success: false, error: `Unknown station: "${destination}". Try a different spelling or 3-letter CRS code.` };

    const bookingUrl = buildTrainlineURL(originCRS, destCRS);

    if (!process.env.TRANSPORT_API_APP_ID || !process.env.TRANSPORT_API_APP_KEY) {
      return { success: true, text: `No live times available right now, but here's Trainline for ${origin} to ${destination}`, bookingUrl };
    }

    const trains = await getNextTrains(originCRS, destCRS);

    if (!trains.length) {
      return { success: true, text: `No trains found from ${origin} to ${destination} right now.`, bookingUrl };
    }

    const lines = trains.map((t, i) => {
      const dep = t.estimatedDeparture && t.estimatedDeparture !== 'On time'
        ? `${t.scheduledDeparture} (exp ${t.estimatedDeparture})` : t.scheduledDeparture;
      const arr = t.estimatedArrival || t.scheduledArrival || '?';
      const plat = t.platform ? ` · Platform ${t.platform}` : '';
      const status = t.cancelled ? ' ✗ CANCELLED' : '';
      return `${i + 1}. ${dep} → ${arr}${plat}${status}`;
    });

    return {
      success: true,
      text: `Next trains from ${origin} to ${destination}:\n${lines.join('\n')}`,
      trains,
      bookingUrl,
    };
  } catch (err) {
    return { success: false, error: `Trainline error: ${err.message}` };
  }
}

module.exports = { SUPPORTED_ACTIONS, execute };
