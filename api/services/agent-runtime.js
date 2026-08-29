const RUNTIME_STATES = new Set([
  'ready',
  'running',
  'paused',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled'
]);

const agentWorkspace = require('./agent-workspace');

const RUNTIME_KINDS = new Set(['task', 'project', 'browser']);
const DEVICE_TYPES = new Set(['ambient_home', 'ios_companion', 'browser', 'unknown']);
const ARTIFACT_KINDS = new Set(['file', 'diff', 'receipt', 'browser_evidence', 'test_result', 'note']);
const MAX_TITLE_LENGTH = 180;
const MAX_SUMMARY_LENGTH = 600;
const MAX_PATH_LENGTH = 180;

function cleanText(value, fallback = '', maxLength = MAX_SUMMARY_LENGTH) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeRuntimeState(value, fallback = 'ready') {
  const state = String(value || '').trim().toLowerCase();
  return RUNTIME_STATES.has(state) ? state : fallback;
}

function normalizeRuntimeKind(value, fallback = 'task') {
  const kind = String(value || '').trim().toLowerCase();
  return RUNTIME_KINDS.has(kind) ? kind : fallback;
}

function normalizeDeviceType(value, fallback = 'ambient_home') {
  const type = String(value || '').trim().toLowerCase();
  return DEVICE_TYPES.has(type) ? type : fallback;
}

function normalizePath(value) {
  const path = String(value || '').trim().replace(/\\/g, '/');
  if (!path || path.length > MAX_PATH_LENGTH || path.startsWith('/') || path.includes('\0')) return null;
  return path.replace(/^\.\/+/, '');
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const safe = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) continue;
    if (typeof raw === 'string') safe[key] = cleanText(raw, '', MAX_SUMMARY_LENGTH);
    else if (typeof raw === 'number' && Number.isFinite(raw)) safe[key] = raw;
    else if (typeof raw === 'boolean') safe[key] = raw;
  }
  return safe;
}

function runtimeSessionRow(userId, input = {}) {
  if (!userId) throw new Error('Runtime session requires a user');
  if (!input.taskId) throw new Error('Runtime session requires a task');
  return {
    user_id: String(userId),
    task_id: String(input.taskId),
    device_id: cleanText(input.deviceId, '', 160) || null,
    device_type: normalizeDeviceType(input.deviceType),
    kind: normalizeRuntimeKind(input.kind),
    project_ref: cleanText(input.projectRef, '', 180) || null,
    title: cleanText(input.title, 'Adam session', MAX_TITLE_LENGTH),
    state: normalizeRuntimeState(input.state),
    metadata: normalizeMetadata(input.metadata),
    updated_at: new Date().toISOString()
  };
}

function artifactRow(userId, input = {}) {
  if (!userId) throw new Error('Artifact requires a user');
  if (!input.sessionId || !input.taskId) throw new Error('Artifact requires a runtime session and task');
  const path = normalizePath(input.path);
  if (input.kind === 'file' && !path) throw new Error('File artifact requires a valid path');
  const kind = ARTIFACT_KINDS.has(input.kind) ? input.kind : 'note';
  return {
    user_id: String(userId),
    session_id: String(input.sessionId),
    task_id: String(input.taskId),
    kind,
    path,
    title: cleanText(input.title, path || 'Agent artifact', MAX_TITLE_LENGTH),
    summary: cleanText(input.summary, 'Artifact recorded', MAX_SUMMARY_LENGTH),
    status: input.status === 'failed' ? 'failed' : 'created',
    workspace_file_id: input.workspaceFileId || null,
    metadata: normalizeMetadata(input.metadata)
  };
}

function summarizeArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind || 'note',
    path: row.path || null,
    title: cleanText(row.title, 'Agent artifact', MAX_TITLE_LENGTH),
    summary: cleanText(row.summary, 'Artifact recorded'),
    status: row.status || 'created',
    createdAt: row.created_at || null
  };
}

function summarizeSession(row, artifacts = []) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    deviceId: row.device_id || null,
    deviceType: normalizeDeviceType(row.device_type, 'unknown'),
    kind: normalizeRuntimeKind(row.kind),
    projectRef: row.project_ref || null,
    title: cleanText(row.title, 'Adam session', MAX_TITLE_LENGTH),
    state: normalizeRuntimeState(row.state),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    heartbeatAt: row.heartbeat_at || null,
    completedAt: row.completed_at || null,
    artifacts: artifacts.map(summarizeArtifact).filter(Boolean)
  };
}

async function getSession(supabase, userId, sessionId) {
  const { data, error } = await supabase.from('agent_runtime_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function ensureSession(supabase, userId, input = {}) {
  const row = runtimeSessionRow(userId, input);
  const existing = await supabase.from('agent_runtime_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('task_id', row.task_id)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data;

  const created = await supabase.from('agent_runtime_sessions')
    .insert(row)
    .select('*')
    .single();
  if (!created.error) return created.data;

  // Two callers can create the same task session while a run is being claimed. The
  // unique task index makes that race safe; return the winner rather than creating a
  // second identity for the same delegated goal.
  if (created.error.code === '23505') {
    const raced = await supabase.from('agent_runtime_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('task_id', row.task_id)
      .maybeSingle();
    if (!raced.error && raced.data) return raced.data;
  }
  throw created.error;
}

async function updateSession(supabase, userId, sessionId, updates = {}) {
  const patch = {};
  if (updates.state !== undefined) patch.state = normalizeRuntimeState(updates.state);
  if (updates.projectRef !== undefined) patch.project_ref = cleanText(updates.projectRef, '', 180) || null;
  if (updates.title !== undefined) patch.title = cleanText(updates.title, 'Adam session', MAX_TITLE_LENGTH);
  if (updates.heartbeatAt !== undefined) patch.heartbeat_at = updates.heartbeatAt;
  if (updates.completedAt !== undefined) patch.completed_at = updates.completedAt;
  if (updates.metadata !== undefined) patch.metadata = normalizeMetadata(updates.metadata);
  patch.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('agent_runtime_sessions')
    .update(patch)
    .eq('user_id', userId)
    .eq('id', sessionId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function recordArtifact(supabase, userId, input = {}) {
  const row = artifactRow(userId, input);
  const { data, error } = await supabase.from('agent_runtime_artifacts')
    .insert(row)
    .select('id, kind, path, title, summary, status, created_at')
    .single();
  if (error) throw error;
  return data;
}

/*
 * The first runtime adapter is the controlled text workspace. Keeping the write and the
 * receipt behind this seam is intentional: a future isolated VM/container adapter can
 * replace it without changing action contracts, task orchestration, or the companion app.
 */
async function writeFileArtifact(supabase, userId, input = {}) {
  const file = await agentWorkspace.writeWorkspaceFile(
    supabase,
    userId,
    input.path,
    input.content,
    input.kind
  );
  let artifact = null;
  try {
    artifact = await recordArtifact(supabase, userId, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      kind: 'file',
      path: file.path,
      title: file.path,
      summary: `Created ${file.path} v${file.version}.`,
      workspaceFileId: file.id
    });
  } catch (error) {
    // The file write is already committed. Do not make a retry replay it merely because
    // its receipt insert was unavailable; return the bounded diagnostic to the caller.
    artifact = null;
  }
  return { file, artifact: artifact ? summarizeArtifact(artifact) : null };
}

async function listArtifacts(supabase, userId, sessionId) {
  const { data, error } = await supabase.from('agent_runtime_artifacts')
    .select('id, kind, path, title, summary, status, created_at')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function getSnapshot(supabase, userId, sessionId) {
  const session = await getSession(supabase, userId, sessionId);
  if (!session) return null;
  return summarizeSession(session, await listArtifacts(supabase, userId, sessionId));
}

module.exports = {
  RUNTIME_STATES,
  RUNTIME_KINDS,
  DEVICE_TYPES,
  ARTIFACT_KINDS,
  normalizeDeviceType,
  normalizeRuntimeState,
  normalizeRuntimeKind,
  runtimeSessionRow,
  artifactRow,
  summarizeArtifact,
  summarizeSession,
  ensureSession,
  getSession,
  updateSession,
  recordArtifact,
  writeFileArtifact,
  listArtifacts,
  getSnapshot
};
