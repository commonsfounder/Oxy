'use strict';

// A selection receipt is the small, durable bridge between an observed set of choices and a
// later human selection. It carries provider identifiers, not ordinals, so a follow-up cannot
// accidentally bind to a different option after prose or ranking changes.

const MAX_OPTIONS = 8;
const MAX_ACTION_TYPE_LENGTH = 80;
const MAX_KEY_LENGTH = 80;
const MAX_VALUE_LENGTH = 240;
const MAX_LABEL_LENGTH = 240;
const MAX_COMMAND_LENGTH = 120;

const SENSITIVE_KEY_RE = /(?:password|secret|token|credential|cookie|authorization|auth|api[_-]?key|card|cvv|cvc|iban|sort[_-]?code)/i;
const SAFE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeSafeInput(input = {}) {
  if (!isPlainObject(input)) return null;
  const keys = Object.keys(input);
  if (keys.length > 24) return null;

  const normalized = {};
  for (const key of keys) {
    if (key.length > MAX_KEY_LENGTH || !SAFE_KEY_RE.test(key) || SENSITIVE_KEY_RE.test(key)) return null;
    const value = input[key];
    if (typeof value === 'string') {
      if (value.length > MAX_VALUE_LENGTH) return null;
      normalized[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      normalized[key] = value;
    } else if (typeof value === 'boolean' || value === null) {
      normalized[key] = value;
    } else {
      // Nested objects and arrays are deliberately excluded. A selection receipt is not a
      // general transport envelope and must remain easy to audit and safe to expose to clients.
      return null;
    }
  }
  return normalized;
}

function normalizeActionSelection(value) {
  if (!isPlainObject(value) || !isPlainObject(value.action) || !Array.isArray(value.options)) return null;
  const type = String(value.action.type || '').trim();
  if (!type || type.length > MAX_ACTION_TYPE_LENGTH || !/^[a-z][a-z0-9_]*$/.test(type)) return null;
  const input = normalizeSafeInput(value.action.input || {});
  if (!input || value.options.length < 1 || value.options.length > MAX_OPTIONS) return null;

  const options = [];
  const ids = new Set();
  for (const option of value.options) {
    if (!isPlainObject(option)) return null;
    const id = String(option.id || '').trim();
    const label = String(option.label || '').trim();
    const command = String(option.command || '').trim();
    const optionInput = normalizeSafeInput(option.input || {});
    if (!id || !label || !command || id.length > MAX_VALUE_LENGTH || label.length > MAX_LABEL_LENGTH || command.length > MAX_COMMAND_LENGTH || !optionInput || ids.has(id)) return null;
    ids.add(id);
    options.push({ id, label, command, input: optionInput });
  }

  return { action: { type, input }, options };
}

function createActionSelection({ actionType, actionInput = {}, options = [] } = {}) {
  return normalizeActionSelection({
    action: { type: actionType, input: actionInput },
    options
  });
}

function resolveActionSelectionOption(selection, index) {
  const normalized = normalizeActionSelection(selection);
  if (!normalized || !Number.isInteger(index) || index < 0 || index >= normalized.options.length) return null;
  const option = normalized.options[index];
  return {
    type: normalized.action.type,
    input: { ...normalized.action.input, ...option.input },
    option
  };
}

module.exports = {
  MAX_OPTIONS,
  createActionSelection,
  normalizeActionSelection,
  resolveActionSelectionOption
};
