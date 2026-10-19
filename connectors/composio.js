const { createComposio } = require('../api/services/composio');

const UNAVAILABLE = { success: false, outcome: 'unavailable', unavailable: true, error: 'That app is not connected yet. No action was taken.' };
let shared = null;
const client = () => (shared ||= createComposio());

// connected_app_read may only call read-style tools; connected_app_act is review-gated by its contract.
async function execute(userId, action, params, composio = client()) {
  if (!composio.configured) return UNAVAILABLE;
  const tool = String(params?.tool || '').toUpperCase();
  if (action === 'connected_app_read' && !composio.isReadTool(tool)) {
    return { success: false, error: `${tool || 'That tool'} changes something, so it needs your approval. No action was taken.` };
  }
  if (action !== 'connected_app_read' && action !== 'connected_app_act') return { success: false, error: 'Unknown app action' };
  try {
    const result = await composio.execute(userId, tool, params?.arguments);
    if (!result.successful) return { success: false, error: result.error || 'The app did not accept that.' };
    return { success: true, text: JSON.stringify(result.data).slice(0, 4000), data: result.data };
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    return { success: false, error: `App error: ${detail}` };
  }
}

module.exports = { execute };
