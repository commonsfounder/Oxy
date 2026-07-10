// Coarse lat/lng -> ISO currency code, so real Stripe charges bill in the customer's local
// currency instead of a hardcoded 'usd' regardless of where the device actually is. Boxes are
// deliberately generous rectangles, not precise borders — good enough to pick the right
// currency, not a geocoder. Order matters: check smaller/nested regions (UK) before the larger
// region that contains them (EU) so the more specific currency wins.
const REGIONS = [
  { code: 'gbp', minLat: 49.8, maxLat: 60.9, minLng: -8.7, maxLng: 1.8 },      // UK & N. Ireland
  { code: 'eur', minLat: 35.0, maxLat: 71.2, minLng: -10.5, maxLng: 31.0 },    // Eurozone (rough)
  { code: 'cad', minLat: 41.6, maxLat: 83.1, minLng: -141.0, maxLng: -52.6 },  // Canada
  { code: 'aud', minLat: -43.7, maxLat: -10.0, minLng: 112.9, maxLng: 153.7 }, // Australia
  { code: 'usd', minLat: 24.4, maxLat: 49.5, minLng: -125.0, maxLng: -66.9 },  // Contiguous US
];

function resolveCurrencyForLocation(location) {
  const lat = Number(location?.latitude ?? location?.lat);
  const lng = Number(location?.longitude ?? location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'usd';
  for (const region of REGIONS) {
    if (lat >= region.minLat && lat <= region.maxLat && lng >= region.minLng && lng <= region.maxLng) {
      return region.code;
    }
  }
  return 'usd';
}

module.exports = { resolveCurrencyForLocation };
