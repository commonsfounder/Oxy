const SUPPORTED_ACTIONS = ['book_lyft'];

async function execute(userId, action, params) {
  const destination = params.destination || params.dropoff || 'destination';
  const url = `https://lyft.com/ride?destination=${encodeURIComponent(destination)}`;
  return { success: true, text: `Opening Lyft for ${destination}.`, deepLink: `lyft://ridetype?id=standard&destination=${encodeURIComponent(destination)}`, webLink: url };
}

module.exports = { SUPPORTED_ACTIONS, execute };