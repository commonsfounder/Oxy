'use strict';

const {
  normalizeWorkspacePath,
  validateWorkspaceContent,
  ensureWorkspace,
  writeWorkspaceFiles,
  createWorkspaceSessions
} = require('./agent-workspace');
const { readExportBundle } = require('./continuity-sources');

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_CONVERSATIONS = 200;
const MAX_MESSAGES_PER_CONVERSATION = 300;
const MAX_TEXT_LENGTH = 8000;
// Rows per insert. An export at the documented ceiling is 60k messages; sending them one
// await at a time is ~30 minutes of round-trips and blows the Fly.io request timeout
// long before it finishes, leaving a partial import with no record of itself.
const INSERT_CHUNK = 500;

function chunk(rows, size = INSERT_CHUNK) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function insertAll(supabase, table, rows) {
  for (const batch of chunk(rows)) {
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw error;
  }
}

function textFromContent(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text.trim();
  if (Array.isArray(value.parts)) return value.parts.map(textFromContent).filter(Boolean).join('\n').trim();
  if (Array.isArray(value.content)) return value.content.map(textFromContent).filter(Boolean).join('\n').trim();
  return '';
}

function roleFromMessage(message = {}) {
  const role = String(message.role || message.author?.role || message.sender || '').toLowerCase();
  if (role === 'assistant' || role === 'model' || role === 'bot') return 'assistant';
  if (role === 'user' || role === 'human') return 'user';
  return null;
}

function messagesFromConversation(conversation = {}) {
  if (Array.isArray(conversation.messages)) return conversation.messages;
  if (Array.isArray(conversation.chat_messages)) return conversation.chat_messages;
  if (Array.isArray(conversation.turns)) return conversation.turns;
  if (!conversation.mapping || typeof conversation.mapping !== 'object') return [];
  return Object.values(conversation.mapping)
    .map(node => node?.message || node)
    .filter(Boolean)
    .sort((a, b) => String(a.create_time || a.created_at || '').localeCompare(String(b.create_time || b.created_at || '')));
}

function normaliseConversation(conversation, index) {
  const messages = messagesFromConversation(conversation)
    .map(message => ({ role: roleFromMessage(message), content: textFromContent(message.content ?? message.text ?? message) }))
    .filter(message => message.role && message.content)
    .slice(0, MAX_MESSAGES_PER_CONVERSATION)
    .map(message => ({ ...message, content: message.content.slice(0, MAX_TEXT_LENGTH) }));
  if (!messages.length) return null;
  return {
    id: String(conversation.id || conversation.uuid || `conversation-${index + 1}`).slice(0, 120),
    title: String(conversation.title || conversation.name || messages[0].content).trim().slice(0, 180) || `Imported conversation ${index + 1}`,
    messages
  };
}

function normaliseDocuments(documents = [], source = 'generic') {
  return (Array.isArray(documents) ? documents : [])
    .map((document, index) => {
      const content = textFromContent(document?.content ?? document?.text ?? document);
      if (!content) return null;
      const name = String(document?.name || document?.title || `document-${index + 1}.txt`).trim();
      const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100) || `document-${index + 1}.txt`;
      return {
        path: normalizeWorkspacePath(`imports/${source}/${safeName}`),
        content: validateWorkspaceContent(content.slice(0, MAX_TEXT_LENGTH * 8)),
        title: name.slice(0, 180)
      };
    })
    .filter(Boolean)
    .slice(0, 100);
}

function normaliseProjects(projects = [], source = 'generic') {
  return (Array.isArray(projects) ? projects : [])
    .map((project, index) => {
      const title = String(project?.title || project?.name || `Imported project ${index + 1}`).trim().slice(0, 180);
      const content = textFromContent(project?.content ?? project?.description ?? project?.instructions);
      const path = normalizeWorkspacePath(`imports/${source}/projects/${title.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100) || `project-${index + 1}`}.md`);
      return { title, content: content ? validateWorkspaceContent(content.slice(0, MAX_TEXT_LENGTH * 8)) : '', path };
    })
    .filter(project => project.title)
    .slice(0, 100);
}

function safeParseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/*
 * A vendor export arrives as a ZIP of JSON files. Unpack in memory and keep only the JSON —
 * chat.html is the same conversations rendered for humans, and re-importing it would double
 * every message.
 */
function filesFromZipBase64(zipBase64) {
  const { unzipSync, strFromU8 } = require('fflate');
  const entries = unzipSync(new Uint8Array(Buffer.from(String(zipBase64), 'base64')));
  const files = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/\.json$/i.test(name) || name.includes('__MACOSX')) continue;
    if (bytes.length > MAX_IMPORT_BYTES) throw new Error(`${name} is too large to import`);
    const parsed = safeParseJSON(strFromU8(bytes));
    if (parsed !== null) files[name] = parsed;
  }
  if (!Object.keys(files).length) throw new Error('That archive contained no readable JSON export files.');
  return files;
}

/*
 * Accepts, in order of fidelity: a ZIP (`zipBase64`), a named file map (`files`), or a
 * single hand-shaped object/array. Only the first two can carry instructions and memory,
 * because in a real export those live in files of their own.
 */
function fileMapFromPayload(payload = {}) {
  if (Array.isArray(payload)) return { '_inline.json': payload };
  if (payload.zipBase64) return filesFromZipBase64(payload.zipBase64);
  if (payload.files && typeof payload.files === 'object' && !Array.isArray(payload.files)) {
    const files = {};
    for (const [name, contents] of Object.entries(payload.files)) {
      const parsed = typeof contents === 'string' ? safeParseJSON(contents) : contents;
      if (parsed !== null && parsed !== undefined) files[name] = parsed;
    }
    if (!Object.keys(files).length) throw new Error('No readable JSON files in that import.');
    return files;
  }
  return { '_inline.json': payload };
}

function normaliseContinuityPayload(payload = {}) {
  const declared = Array.isArray(payload)
    ? 'generic'
    : String(payload?.source || payload?.provider || 'generic').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'generic';

  const bundle = readExportBundle(fileMapFromPayload(payload), declared);
  const source = bundle.source;

  const conversations = asList(bundle.conversations)
    .map(normaliseConversation)
    .filter(Boolean)
    .slice(0, MAX_CONVERSATIONS);

  const instructions = asList(bundle.instructions)
    .map(textFromContent)
    .filter(Boolean)
    .map(text => text.slice(0, MAX_TEXT_LENGTH))
    .slice(0, 20);

  // Memory the vendor already curated. Kept apart from the regex-derived candidates in
  // importedMemoryCandidates(): these are explicit facts the user's other assistant was
  // told to remember, so they carry more weight and skip the heuristic filter.
  const memories = asList(bundle.memories)
    .map(entry => String(entry || '').replace(/\s+/g, ' ').trim())
    .filter(text => text.length > 3)
    .map(text => text.slice(0, 500))
    .slice(0, 200);

  return {
    source,
    conversations,
    projects: normaliseProjects(bundle.projects || [], source),
    documents: normaliseDocuments(bundle.documents || [], source),
    instructions,
    memories,
    workflows: asList(bundle.workflows).slice(0, 200),
    coverage: bundle.coverage || {}
  };
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function importedMemoryCandidates(normalised) {
  const candidates = [];
  const add = value => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 12 || candidates.some(existing => existing.toLowerCase() === text.toLowerCase())) return;
    if (/\b(i|we|my|our)\b/i.test(text) && /\b(live|work|build|prefer|use|want|goal|like|love|hate|need|based|from)\b/i.test(text)) {
      candidates.push(text.slice(0, 500));
    }
  };
  normalised.instructions.forEach(add);
  normalised.projects.forEach(project => add(`${project.title}: ${project.content}`));
  normalised.conversations.flatMap(conversation => conversation.messages)
    .filter(message => message.role === 'user')
    .forEach(message => message.content.split(/[.!?\n]+/).forEach(add));
  return candidates.slice(0, 30);
}

/*
 * Imported automations land in `routines` always disabled — the original is still live at the
 * source while this runs, and switching the copy on doubles every action it performs. So
 * `enabled: false` unconditionally, never derived from activeAtSource. Upserted on
 * (user_id, source, external_id) so a re-import updates rather than stacking duplicates.
 */
async function importWorkflows(supabase, userId, normalised) {
  if (!normalised.workflows.length) return;
  const rows = normalised.workflows.map(workflow => ({
    user_id: userId,
    name: workflow.name,
    prompt: workflow.prompt,
    // Left NULL for event-triggered automations: `routines` only schedules on an interval,
    // so an event trigger has nothing to map onto and must not silently become a timer.
    interval_minutes: workflow.triggerKind === 'schedule' ? workflow.intervalMinutes : null,
    next_run_at: null,
    enabled: false,
    source: normalised.source,
    external_id: workflow.externalId,
    metadata: {
      importedFrom: normalised.source,
      triggerKind: workflow.triggerKind,
      activeAtSource: workflow.activeAtSource === true,
      original: workflow.raw || {}
    }
  }));
  for (const batch of chunk(rows)) {
    const { error } = await supabase.from('routines')
      .upsert(batch, { onConflict: 'user_id,source,external_id' });
    if (error) throw error;
  }
}

/*
 * Dry run: everything importContinuity would write, computed without writing any of it.
 * An import that silently drops three-quarters of an export is the failure mode this whole
 * module exists to avoid, so the user sees the coverage report before committing.
 */
function previewContinuity(payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload || {}), 'utf8');
  if (bytes > MAX_IMPORT_BYTES) throw new Error('Import is too large');
  const normalised = normaliseContinuityPayload(payload);
  return {
    source: normalised.source,
    coverage: normalised.coverage,
    counts: {
      conversations: normalised.conversations.length,
      messages: normalised.conversations.reduce((total, c) => total + c.messages.length, 0),
      projects: normalised.projects.length,
      documents: normalised.documents.length,
      instructions: normalised.instructions.length,
      memories: normalised.memories.length,
      workflows: normalised.workflows.length,
      scheduledWorkflows: normalised.workflows.filter(w => w.triggerKind === 'schedule').length,
      eventWorkflows: normalised.workflows.filter(w => w.triggerKind === 'event').length
    },
    workflows: normalised.workflows.map(workflow => ({
      name: workflow.name,
      triggerKind: workflow.triggerKind,
      intervalMinutes: workflow.intervalMinutes,
      activeAtSource: workflow.activeAtSource === true,
      prompt: workflow.prompt
    }))
  };
}

const IMPORT_ROW_FIELDS =
  'id, source, status, conversation_count, message_count, project_count, document_count, memory_count, metadata, created_at';

async function importContinuity(supabase, userId, payload) {
  // Size first: rejecting an oversized export after parsing and normalising it means doing
  // all the work anyway.
  const bytes = Buffer.byteLength(JSON.stringify(payload || {}), 'utf8');
  if (bytes > MAX_IMPORT_BYTES) throw new Error('Import is too large');

  const normalised = normaliseContinuityPayload(payload);
  const messageCount = normalised.conversations.reduce((total, c) => total + c.messages.length, 0);

  // Vendor-curated memory first, then facts inferred from the conversations. Deduped as one
  // set so an explicit memory isn't re-added in a slightly different wording by the heuristic.
  const candidates = [...normalised.memories, ...importedMemoryCandidates(normalised)];
  const existingMemory = await supabase.from('memories').select('content').eq('user_id', userId).limit(200);
  const known = new Set((existingMemory.data || []).map(row => String(row.content || '').toLowerCase()));
  const newMemories = [];
  for (const content of candidates) {
    const key = content.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    newMemories.push(content);
  }

  // Claim the import row up front. If anything below fails or the request is cut off, the
  // user still has a record explaining why their history is half-there, instead of a
  // silent partial write that a retry would duplicate.
  const claimed = await supabase.from('agent_imports').insert({
    user_id: userId,
    source: normalised.source,
    status: 'running',
    conversation_count: normalised.conversations.length,
    message_count: messageCount,
    project_count: normalised.projects.length,
    document_count: normalised.documents.length,
    memory_count: newMemories.length,
    metadata: {
      instructionCount: normalised.instructions.length,
      workflowCount: normalised.workflows.length,
      coverage: normalised.coverage
    }
  }).select(IMPORT_ROW_FIELDS).single();
  if (claimed.error) throw claimed.error;

  try {
    const now = new Date().toISOString();
    await insertAll(supabase, 'conversations', normalised.conversations.flatMap(conversation =>
      conversation.messages.map(message => ({
        user_id: userId,
        role: message.role,
        content: message.content,
        created_at: now
      }))
    ));
    await insertAll(supabase, 'memories', [
      ...newMemories.map(content => ({ user_id: userId, content, source: 'imported_memory', created_at: now })),
      ...normalised.instructions.map(content => ({ user_id: userId, content, source: 'imported_instruction', created_at: now }))
    ]);

    const workspace = await ensureWorkspace(supabase, userId);
    await writeWorkspaceFiles(supabase, userId, [
      ...normalised.documents.map(document => ({ path: document.path, content: document.content })),
      ...normalised.projects.map(project => ({
        path: project.path,
        content: `# ${project.title}\n\n${project.content}`.trim()
      }))
    ], workspace);
    await createWorkspaceSessions(supabase, userId, normalised.projects.map(project => ({
      kind: 'project',
      title: project.title,
      state: { source: normalised.source, imported: true, path: project.path }
    })), workspace);
    await importWorkflows(supabase, userId, normalised);
  } catch (e) {
    await supabase.from('agent_imports').update({ status: 'failed' }).eq('id', claimed.data.id).eq('user_id', userId);
    throw e;
  }

  const finished = await supabase.from('agent_imports')
    .update({ status: 'completed' })
    .eq('id', claimed.data.id)
    .eq('user_id', userId)
    .select(IMPORT_ROW_FIELDS)
    .single();
  if (finished.error) throw finished.error;

  return {
    import: finished.data,
    coverage: normalised.coverage,
    imported: {
      conversations: normalised.conversations.length,
      messages: messageCount,
      projects: normalised.projects.length,
      documents: normalised.documents.length,
      memories: newMemories.length,
      instructions: normalised.instructions.length,
      workflows: normalised.workflows.length
    }
  };
}

module.exports = {
  MAX_IMPORT_BYTES,
  normaliseContinuityPayload,
  importedMemoryCandidates,
  importContinuity,
  previewContinuity,
  filesFromZipBase64,
  fileMapFromPayload
};
