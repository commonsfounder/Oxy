const path = require('node:path');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 180;

function normalizeWorkspacePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || raw === '.') return 'README.md';
  if (raw.length > MAX_PATH_LENGTH || raw.startsWith('/') || raw.includes('\0')) {
    throw new Error('Invalid workspace path');
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Invalid workspace path');
  }
  return normalized.replace(/^\.\/+/, '');
}

function validateWorkspaceContent(content) {
  if (typeof content !== 'string') throw new Error('Workspace content must be text');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('Workspace file is too large');
  }
  return content;
}

async function ensureWorkspace(supabase, userId) {
  const existing = await supabase.from('agent_workspaces')
    .select('id, user_id, name, metadata, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (existing.data) return existing.data;
  const created = await supabase.from('agent_workspaces')
    .insert({ user_id: userId, name: 'Millie workspace', metadata: {} })
    .select('id, user_id, name, metadata, created_at, updated_at')
    .single();
  if (created.error) throw created.error;
  return created.data;
}

async function listWorkspaceFiles(supabase, userId, prefix = '') {
  const workspace = await ensureWorkspace(supabase, userId);
  const normalizedPrefix = prefix ? normalizeWorkspacePath(prefix) : '';
  let query = supabase.from('agent_workspace_files')
    .select('id, path, kind, size_bytes, version, updated_at')
    .eq('workspace_id', workspace.id)
    .eq('user_id', userId)
    .order('path', { ascending: true });
  if (normalizedPrefix) query = query.ilike('path', normalizedPrefix + '%');
  const { data, error } = await query;
  if (error) throw error;
  return { workspace, files: data || [] };
}

async function readWorkspaceFile(supabase, userId, filePath, workspace = null) {
  workspace = workspace || await ensureWorkspace(supabase, userId);
  const normalizedPath = normalizeWorkspacePath(filePath);
  const { data, error } = await supabase.from('agent_workspace_files')
    .select('id, path, kind, content, size_bytes, version, created_at, updated_at')
    .eq('workspace_id', workspace.id)
    .eq('user_id', userId)
    .eq('path', normalizedPath)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function writeWorkspaceFile(supabase, userId, filePath, content, kind = 'file', workspace = null) {
  const [written] = await writeWorkspaceFiles(
    supabase,
    userId,
    [{ path: filePath, content, kind }],
    workspace
  );
  return written;
}

/*
 * Batch counterpart to writeWorkspaceFile: one existing-version lookup and one upsert for
 * the whole set, instead of ~4 round-trips per file. Paths are deduped (last write wins)
 * because Postgres rejects an ON CONFLICT DO UPDATE that would touch the same row twice in
 * a single statement.
 */
async function writeWorkspaceFiles(supabase, userId, files = [], workspace = null) {
  if (!files.length) return [];

  // Validate before touching the database. A model-authored path is rejected here, so a
  // traversal attempt or an oversized write costs no round-trip and cannot create a
  // workspace row as a side effect of being refused.
  const byPath = new Map();
  for (const file of files) {
    const normalizedPath = normalizeWorkspacePath(file?.path);
    const kind = file?.kind === 'folder' ? 'folder' : 'file';
    const cleanContent = kind === 'folder' ? '' : validateWorkspaceContent(file?.content);
    byPath.set(normalizedPath, {
      user_id: userId,
      path: normalizedPath,
      kind,
      content: cleanContent,
      size_bytes: Buffer.byteLength(cleanContent, 'utf8'),
      updated_at: new Date().toISOString()
    });
  }

  workspace = workspace || await ensureWorkspace(supabase, userId);
  for (const row of byPath.values()) row.workspace_id = workspace.id;

  const paths = [...byPath.keys()];
  const existing = await supabase.from('agent_workspace_files')
    .select('path, version')
    .eq('workspace_id', workspace.id)
    .eq('user_id', userId)
    .in('path', paths);
  if (existing.error) throw existing.error;
  const versions = new Map((existing.data || []).map(row => [row.path, row.version || 0]));

  const rows = paths.map(p => ({ ...byPath.get(p), version: (versions.get(p) || 0) + 1 }));
  const { data, error } = await supabase.from('agent_workspace_files')
    .upsert(rows, { onConflict: 'workspace_id,path' })
    .select('id, path, kind, content, size_bytes, version, created_at, updated_at');
  if (error) throw error;
  return data || [];
}

async function listWorkspaceSessions(supabase, userId) {
  const workspace = await ensureWorkspace(supabase, userId);
  const { data, error } = await supabase.from('agent_workspace_sessions')
    .select('id, kind, title, state, created_at, updated_at')
    .eq('workspace_id', workspace.id)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return { workspace, sessions: data || [] };
}

function workspaceSessionRow(workspace, userId, { kind = 'task', title, state = {} } = {}) {
  const cleanTitle = String(title || '').trim().slice(0, 180);
  if (!cleanTitle) throw new Error('Session title is required');
  return {
    workspace_id: workspace.id,
    user_id: userId,
    kind: ['chat', 'task', 'browser', 'project'].includes(kind) ? kind : 'task',
    title: cleanTitle,
    state: state && typeof state === 'object' ? state : {}
  };
}

async function createWorkspaceSession(supabase, userId, session = {}, workspace = null) {
  const [created] = await createWorkspaceSessions(supabase, userId, [session], workspace);
  return created;
}

async function createWorkspaceSessions(supabase, userId, sessions = [], workspace = null) {
  if (!sessions.length) return [];
  workspace = workspace || await ensureWorkspace(supabase, userId);
  const rows = sessions.map(session => workspaceSessionRow(workspace, userId, session));
  const { data, error } = await supabase.from('agent_workspace_sessions')
    .insert(rows)
    .select('id, kind, title, state, created_at, updated_at');
  if (error) throw error;
  return data || [];
}

module.exports = {
  MAX_FILE_BYTES,
  normalizeWorkspacePath,
  validateWorkspaceContent,
  ensureWorkspace,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  writeWorkspaceFiles,
  listWorkspaceSessions,
  createWorkspaceSession,
  createWorkspaceSessions
};
