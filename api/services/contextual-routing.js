function shouldClarifyPreviousPlace(message) {
  const normalized = String(message || '').trim().toLowerCase();
  return /\b(is|was)\s+(that|this|it)\s+(definitely\s+)?(the\s+)?(nearest|closest)\b/i.test(normalized) ||
    /\b(that|this|it)\s+(definitely|sure)?\s*(the\s+)?(nearest|closest)\b/i.test(normalized) ||
    (/\b(definitely|sure)\b/i.test(normalized) && /\b(that|this|it)\b/i.test(normalized) && /\b(nearest|closest|place|location)\b/i.test(normalized));
}

module.exports = {
  shouldClarifyPreviousPlace
};
