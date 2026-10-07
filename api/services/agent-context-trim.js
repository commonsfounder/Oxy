'use strict';
// What the model is shown of past tool results. A page observation is only actionable while it
// is the latest one (element numbers belong to that page), and it carries the same controls and
// text two or three ways for other consumers. The model gets each once, and only the newest in full.

const STALE_NOTE = 'Earlier page; its controls are no longer valid. Use the latest observation.';

// A browser step's result: a page address, a title and the rendered page text.
function isPageResult(result) {
  return Boolean(result) && typeof result === 'object'
    && typeof result.url === 'string' && 'pageTitle' in result && typeof result.text === 'string';
}

/** The model's view of one result: drop the copies of what `text` already says. */
function modelView(result) {
  if (!isPageResult(result) || !Array.isArray(result.elements)) return result;
  const { elements: _elements, pageText: _pageText, ...rest } = result;
  return rest;
}

/** The lightest useful record of a page the agent has moved on from. */
function staleView(result) {
  const out = { success: result.success, url: result.url, pageTitle: result.pageTitle, note: STALE_NOTE };
  if (result.changed) out.changed = result.changed;
  if (result.blocked) out.blocked = result.blocked;
  return out;
}

/**
 * Shrinks, in place, every browser observation in the conversation except the newest one.
 * `contents` is the Gemini-style turn list; function responses carry the result as a JSON string.
 */
function compactStaleObservations(contents) {
  const slots = [];
  for (const turn of contents) {
    for (const part of turn?.parts || []) {
      const response = part?.functionResponse?.response;
      if (response && typeof response.result === 'string' && response.result.length > 400) slots.push(response);
    }
  }
  let newest = -1;
  const parsed = slots.map((response, index) => {
    try {
      const value = JSON.parse(response.result);
      if (isPageResult(value) || value?.note === STALE_NOTE) { newest = index; return value; }
    } catch { /* not JSON, leave alone */ }
    return null;
  });
  parsed.forEach((value, index) => {
    if (value && index !== newest && value.note !== STALE_NOTE) slots[index].result = JSON.stringify(staleView(value));
  });
  return contents;
}

module.exports = { modelView, compactStaleObservations, STALE_NOTE };
