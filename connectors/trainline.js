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

function stripNs(xml) {
  return xml.replace(/<[a-zA-Z0-9]+:/g, '<').replace(/<\/[a-zA-Z0-9]+:/g, '</');
}

function tag(xml, name) {
  const m = stripNs(xml).match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

function allTags(xml, name) {
  const stripped = stripNs(xml);
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi');
  const out = []; let m;
  while ((m = re.exec(stripped)) !== null) out.push(m[1].trim());
  return out;
}

function parseTrains(xml) {
  return allTags(xml, 'service').map(svc => ({
    scheduledDeparture: tag(svc, 'std'),
    estimatedDeparture: tag(svc, 'etd'),
    scheduledArrival:   tag(svc, 'sta'),
    estimatedArrival:   tag(svc, 'eta'),
    platform:           tag(svc, 'platform'),
    destination:        tag(tag(svc, 'destination') || '', 'locationName'),
    operator:           tag(svc, 'operator'),
    cancelled:          /isCancelled>true/i.test(svc),
  }));
}

async function getNextTrains(originCRS, destCRS) {
  const soap = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:ldb="http://thalesgroup.com/RTTI/2017-10-01/ldb/"
               xmlns:tok="http://thalesgroup.com/RTTI/2013-11-28/Token/types">
  <soap:Header>
    <tok:AccessToken><tok:TokenValue>${process.env.DARWIN_API_TOKEN}</tok:TokenValue></tok:AccessToken>
  </soap:Header>
  <soap:Body>
    <ldb:GetDepBoardWithDetailsRequest>
      <ldb:numRows>3</ldb:numRows>
      <ldb:crs>${originCRS}</ldb:crs>
      <ldb:filterCrs>${destCRS}</ldb:filterCrs>
      <ldb:filterType>to</ldb:filterType>
    </ldb:GetDepBoardWithDetailsRequest>
  </soap:Body>
</soap:Envelope>`;

  const resp = await axios.post(
    'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb11.asmx',
    soap,
    { headers: { 'Content-Type': 'text/xml; charset=utf-8' }, timeout: 10000 }
  );
  return parseTrains(resp.data);
}

function buildTrainlineURL(origin, destination) {
  const slug = s => s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return `https://www.thetrainline.com/trains/${slug(origin)}/${slug(destination)}`;
}

async function execute(userId, action, params) {
  try {
    if (action !== 'search_trains') return { success: false, error: `Unknown action: ${action}` };

    const { origin, destination } = params;
    if (!origin || !destination) return { success: false, error: 'search_trains requires origin and destination' };

    const originCRS  = toCRS(origin);
    const destCRS    = toCRS(destination);
    const bookingUrl = buildTrainlineURL(origin, destination);

    if (!originCRS) return { success: false, error: `Unknown station: "${origin}". Try a full station name or 3-letter CRS code.` };
    if (!destCRS)   return { success: false, error: `Unknown station: "${destination}". Try a full station name or 3-letter CRS code.` };

    if (!process.env.DARWIN_API_TOKEN) {
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
