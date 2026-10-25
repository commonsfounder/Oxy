'use strict';

// After several steps, a model sometimes finishes by repeating one tool's stock status line
// ("Walking directions to X are ready.") instead of answering. That line carries no answer.

function normalise(text) {
  return String(text || '').toLowerCase().replace(/[*_`#>\[\]()]/g, ' ').replace(/[^a-z0-9£$€%.:\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isEchoOfToolText(spoken, executedActions) {
  const said = normalise(spoken);
  if (!said || said.length > 220 || !Array.isArray(executedActions) || executedActions.length < 2) return false;
  return executedActions.some((entry) => {
    const stock = normalise(entry?.result?.text);
    if (stock.length < 15) return false;
    return said === stock || (said.length <= stock.length + 20 && (said.includes(stock) || stock.includes(said)));
  });
}

const WRITE_UP_PROMPT = 'That line is only a status message from one tool. Using all the results above, answer my original request properly in a few plain sentences, with the specific facts and numbers I asked for.';

module.exports = { isEchoOfToolText, WRITE_UP_PROMPT };
