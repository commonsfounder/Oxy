'use strict';

// A search answers the narrow question the model typed into it ("tallest building in Manchester").
// The user's real question is wider ("how much taller is it than Birmingham's?"), so when the turn
// ended on search results, one more call writes the answer to the whole question from them.

const RESEARCH_ACTIONS = new Set(['web_search', 'web_browse']);

function researchResults(actionResults) {
  return (Array.isArray(actionResults) ? actionResults : [])
    .filter((entry) => RESEARCH_ACTIONS.has(entry?.action)
      && entry.result?.outcome === 'completed'
      && String(entry.result?.text || '').trim().length >= 40)
    .map((entry) => ({ action: entry.action, text: String(entry.result.text).trim().slice(0, 3000) }));
}

// Only when every step that ran was a lookup that worked: a turn that also sent, booked or handed
// off something keeps its own wording, which has to be exact.
function shouldWriteUp(actionResults) {
  const results = Array.isArray(actionResults) ? actionResults : [];
  return researchResults(results).length > 0
    && results.every((entry) => RESEARCH_ACTIONS.has(entry?.action) && entry.result?.outcome === 'completed');
}

function researchSynthesisPrompt(message, research) {
  const found = research.map((item, index) => `[${index + 1}] ${item.text}`).join('\n\n');
  return `The person asked: "${message}"\n\nThis is what the lookups found:\n${found}\n\n`
    + 'Answer what they asked, using only what the lookups found, in a few plain sentences. Answer every part: '
    + 'if they asked you to compare, name both and say the result (which is higher, cheaper, earlier or later) and by how much; '
    + 'give numbers with their units; if two sources disagree or a figure could not be confirmed, say so briefly. '
    + 'Do not mention the lookups or add links.';
}

module.exports = { researchResults, shouldWriteUp, researchSynthesisPrompt };
