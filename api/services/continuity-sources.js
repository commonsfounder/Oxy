'use strict';

/*
 * Turns a real vendor export into one canonical bundle. Input is a FILE MAP
 * ({ 'conversations.json': <parsed>, ... }), because a real export is a ZIP of separate files
 * with the conversations in one and the profile material in others.
 *
 * Conversation payloads are stable, but vendors move the instructions and memory files between
 * export versions, so each extractor sweeps a candidate list and reports `found`/`missing` —
 * the UI can then say what was not in this export rather than quietly importing three-quarters.
 */

const MAX_TEXT = 8000;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

// Pull plain text out of the many shapes vendors use for a message body.
function textFrom(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join('\n').trim();
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.value === 'string') return value.value.trim();
  if (Array.isArray(value.parts)) return textFrom(value.parts);
  if (Array.isArray(value.content)) return textFrom(value.content);
  return '';
}

function baseName(path) {
  return String(path || '').split('/').pop().toLowerCase();
}

/* Find the first file whose basename matches any candidate. */
function pickFile(files, candidates) {
  for (const candidate of candidates) {
    for (const [name, contents] of Object.entries(files || {})) {
      if (baseName(name) === candidate) return { name, contents };
    }
  }
  return null;
}

/*
 * Deep-scan a parsed file for the first value under any of `keys`. Vendors nest the
 * profile material at different depths across export versions; the key names have been
 * far more stable than their position, so search by key rather than by path.
 */
function findByKey(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const key of keys) {
    if (node[key] !== undefined && node[key] !== null && node[key] !== '') return node[key];
  }
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findByKey(value, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

const INSTRUCTION_KEYS = ['custom_instructions', 'customInstructions', 'system_prompt', 'instructions', 'about_user_message', 'about_model_message'];
const MEMORY_KEYS = ['memories', 'model_memories', 'memory_entries', 'saved_memories', 'user_memories'];

/*
 * Collect every string inside a node. Custom instructions are not one string: ChatGPT splits
 * them into about_user_message / about_model_message under a `custom_instructions` object,
 * and treating the matched node as text drops both halves.
 */
function stringLeaves(node, depth = 0, out = []) {
  if (out.length >= 40 || depth > 5) return out;
  if (typeof node === 'string') {
    const text = node.trim();
    if (text) out.push(text);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const value of Array.isArray(node) ? node : Object.values(node)) stringLeaves(value, depth + 1, out);
  return out;
}

function extractInstructions(files) {
  const found = [];
  for (const contents of Object.values(files || {})) {
    const hit = findByKey(contents, INSTRUCTION_KEYS);
    if (!hit) continue;
    for (const text of stringLeaves(hit)) found.push(text.slice(0, MAX_TEXT));
  }
  return [...new Set(found)].slice(0, 20);
}

function extractMemories(files) {
  const found = [];
  for (const contents of Object.values(files || {})) {
    const hit = findByKey(contents, MEMORY_KEYS);
    if (!hit) continue;
    for (const entry of asArray(hit)) {
      const text = textFrom(entry) || clean(entry?.content ?? entry?.memory ?? entry);
      if (text && text.length > 3) found.push(text.slice(0, MAX_TEXT));
    }
  }
  return [...new Set(found)].slice(0, 200);
}

/* ── ChatGPT ─────────────────────────────────────────────────────────────── */

function isChatGPTExport(files) {
  const conversations = pickFile(files, ['conversations.json']);
  if (!conversations) return false;
  const first = asArray(conversations.contents)[0];
  return Boolean(first && (first.mapping || first.create_time));
}

function chatgptAdapter(files) {
  const conversationsFile = pickFile(files, ['conversations.json']);
  const conversations = asArray(conversationsFile?.contents);
  const instructions = extractInstructions(files);
  const memories = extractMemories(files);
  return {
    source: 'chatgpt',
    conversations,
    projects: asArray(pickFile(files, ['projects.json'])?.contents),
    documents: [],
    instructions,
    memories,
    workflows: [],
    coverage: {
      conversations: { found: conversations.length > 0, count: conversations.length },
      instructions: { found: instructions.length > 0, count: instructions.length },
      memories: { found: memories.length > 0, count: memories.length }
    }
  };
}

/* ── Claude ──────────────────────────────────────────────────────────────── */

function isClaudeExport(files) {
  const conversations = pickFile(files, ['conversations.json']);
  if (!conversations) return false;
  const first = asArray(conversations.contents)[0];
  return Boolean(first && (first.chat_messages || first.uuid));
}

function claudeAdapter(files) {
  const conversations = asArray(pickFile(files, ['conversations.json'])?.contents);
  const projects = asArray(pickFile(files, ['projects.json'])?.contents);
  const instructions = extractInstructions(files);
  const memories = extractMemories(files);
  return {
    source: 'claude',
    conversations,
    projects,
    documents: projects.flatMap(project => asArray(project?.docs).map(doc => ({
      name: doc?.filename || doc?.name,
      content: textFrom(doc?.content ?? doc)
    })).filter(doc => doc.content)),
    instructions,
    memories,
    workflows: [],
    coverage: {
      conversations: { found: conversations.length > 0, count: conversations.length },
      projects: { found: projects.length > 0, count: projects.length },
      instructions: { found: instructions.length > 0, count: instructions.length },
      memories: { found: memories.length > 0, count: memories.length }
    }
  };
}

/* ── Zapier ──────────────────────────────────────────────────────────────── */

// Zapier's own export ("Download all private and shared Zaps") carries triggers, actions
// and flow logic but no credentials — those are re-authorised through Oxy's connectors.
function isZapierExport(files) {
  for (const contents of Object.values(files || {})) {
    const zaps = findByKey(contents, ['zaps']) || (Array.isArray(contents) ? contents : null);
    const first = asArray(zaps)[0];
    if (first && (first.nodes || first.steps) && (first.title || first.name)) return true;
  }
  return false;
}

function stepLabel(step) {
  const app = clean(step?.app || step?.selected_api || step?.service || step?.type);
  const action = clean(step?.action || step?.event || step?.title || step?.name);
  if (app && action && !action.toLowerCase().includes(app.toLowerCase())) return `${app}: ${action}`;
  return action || app || '';
}

/*
 * A Zap is a graph and Oxy executes a prompt, so the translation restates the automation's
 * intent and lets the agent loop supply the branching. The original graph stays in metadata.
 */
function zapToRoutine(zap, index) {
  const steps = asArray(zap?.nodes || zap?.steps);
  const [trigger, ...actions] = steps;
  const name = clean(zap?.title || zap?.name) || `Imported automation ${index + 1}`;
  const triggerLabel = stepLabel(trigger);
  const actionLabels = actions.map(stepLabel).filter(Boolean);

  const intervalMinutes = scheduleToMinutes(trigger);
  const prompt = [
    actionLabels.length ? `Do this: ${actionLabels.join(', then ')}.` : `Carry out the "${name}" automation.`,
    triggerLabel ? `Original trigger: ${triggerLabel}.` : '',
    intervalMinutes ? '' : 'This ran on an event in the source tool, not a schedule — check whether it still needs doing.'
  ].filter(Boolean).join(' ');

  return {
    externalId: clean(zap?.id || zap?.zap_id || zap?.uuid) || `zap-${index + 1}`,
    name: name.slice(0, 180),
    prompt: prompt.slice(0, MAX_TEXT),
    intervalMinutes,
    triggerKind: intervalMinutes ? 'schedule' : 'event',
    activeAtSource: zap?.state === 'on' || zap?.status === 'on' || zap?.enabled === true,
    raw: { trigger: triggerLabel, actions: actionLabels }
  };
}

// Only schedule triggers map onto `routines.interval_minutes`. Everything else imports
// inert — see the routine-provenance migration for why nothing arrives switched on.
function scheduleToMinutes(trigger) {
  const label = `${stepLabel(trigger)} ${clean(trigger?.selected_api)}`.toLowerCase();
  if (!/schedule|every|interval|cron|timer/.test(label)) return null;
  const params = trigger?.params || trigger?.parameters || {};
  const explicit = Number(params.interval_minutes ?? params.minutes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, 60 * 24 * 30);
  if (/month/.test(label)) return 60 * 24 * 30;
  if (/week/.test(label)) return 60 * 24 * 7;
  if (/day|daily/.test(label)) return 60 * 24;
  if (/hour/.test(label)) return 60;
  if (/minute/.test(label)) return 15;
  return 60 * 24;
}

function zapierAdapter(files) {
  const zaps = [];
  for (const contents of Object.values(files || {})) {
    const found = findByKey(contents, ['zaps']) || (Array.isArray(contents) ? contents : null);
    for (const zap of asArray(found)) {
      if (zap && (zap.nodes || zap.steps)) zaps.push(zap);
    }
  }
  const workflows = zaps.slice(0, 200).map(zapToRoutine);
  return {
    source: 'zapier',
    conversations: [],
    projects: [],
    documents: [],
    instructions: [],
    memories: [],
    workflows,
    coverage: {
      workflows: { found: workflows.length > 0, count: workflows.length },
      scheduled: { found: true, count: workflows.filter(w => w.triggerKind === 'schedule').length },
      eventTriggered: { found: true, count: workflows.filter(w => w.triggerKind === 'event').length }
    }
  };
}

/* ── Generic ─────────────────────────────────────────────────────────────── */

// Anything hand-shaped, plus the single-file case (a bare conversations array).
function genericAdapter(files, declaredSource = 'generic') {
  const merged = {};
  for (const contents of Object.values(files || {})) {
    if (contents && typeof contents === 'object' && !Array.isArray(contents)) Object.assign(merged, contents);
  }
  const bare = Object.values(files || {}).find(Array.isArray);
  const conversations = asArray(merged.conversations || merged.chats || merged.history || bare);
  const instructions = extractInstructions(files);
  const memories = extractMemories(files);
  return {
    source: declaredSource,
    conversations,
    projects: asArray(merged.projects),
    documents: asArray(merged.documents || merged.files),
    instructions,
    memories,
    workflows: [],
    coverage: {
      conversations: { found: conversations.length > 0, count: conversations.length },
      instructions: { found: instructions.length > 0, count: instructions.length },
      memories: { found: memories.length > 0, count: memories.length }
    }
  };
}

const ADAPTERS = [
  { detect: isChatGPTExport, adapt: chatgptAdapter },
  { detect: isClaudeExport, adapt: claudeAdapter },
  { detect: isZapierExport, adapt: zapierAdapter }
];

/*
 * `files` is a map of filename -> parsed JSON. `declaredSource` is only a fallback: a real
 * export identifies itself by layout, and trusting the client's label over the actual
 * contents is how you get a Claude export parsed as ChatGPT.
 */
function readExportBundle(files = {}, declaredSource = 'generic') {
  for (const { detect, adapt } of ADAPTERS) {
    if (detect(files)) return adapt(files);
  }
  return genericAdapter(files, declaredSource);
}

module.exports = {
  readExportBundle,
  extractInstructions,
  extractMemories,
  zapToRoutine,
  scheduleToMinutes,
  isChatGPTExport,
  isClaudeExport,
  isZapierExport
};
