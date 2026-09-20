const { Client, lookupAddress, lookupPostcode } = require('@ideal-postcodes/core-axios');

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

function addressLabel(address) {
  return [address.line_1, address.line_2, address.line_3, address.post_town, address.postcode]
    .filter(Boolean)
    .join(', ');
}

function publicAddress(address) {
  return {
    id: String(address.udprn || address.umprn || address.id || addressLabel(address)),
    address: addressLabel(address)
  };
}

async function lookupHomeAddresses(query, { apiKey = process.env.IDEAL_POSTCODES_API_KEY, client, postcodeLookup = lookupPostcode, addressLookup = lookupAddress } = {}) {
  if (!apiKey && !client) {
    const error = new Error('Address lookup is not configured.');
    error.code = 'ADDRESS_LOOKUP_NOT_CONFIGURED';
    throw error;
  }

  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];

  const lookupClient = client || new Client({ api_key: apiKey });
  const addresses = UK_POSTCODE.test(normalizedQuery)
    ? await postcodeLookup({ client: lookupClient, postcode: normalizedQuery })
    : await addressLookup({ client: lookupClient, query: normalizedQuery, limit: 10 });

  return addresses.map(publicAddress).filter(({ address }) => address);
}

module.exports = { lookupHomeAddresses, addressLabel, publicAddress };
