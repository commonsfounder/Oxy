'use strict';
// Contextual follow-up routing helpers. Pure text heuristics so they stay unit-testable
// and never need model calls.

// "Is that the right place?" / "that looks wrong" style follow-ups after a find_place —
// the user is questioning the previous place result, not asking a fresh search.
const CLARIFY_PLACE_PATTERN = /\b(?:is (?:that|this) (?:the )?(?:right|correct) (?:place|one|address|location)|(?:that|this) (?:place|address|location|one) (?:is|looks|seems) (?:wrong|off|incorrect|not right)|(?:that|this) (?:isn'?t|is not|doesn'?t look like) (?:the )?(?:right|correct)|why did you (?:pick|choose|suggest) (?:that|this)|are you sure (?:that|this|about that)|where did you get that (?:place|address|location))\b/i;

function shouldClarifyPreviousPlace(normalizedText) {
  return CLARIFY_PLACE_PATTERN.test(String(normalizedText || ''));
}

module.exports = { shouldClarifyPreviousPlace };
