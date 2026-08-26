'use strict';

const { decryptTokens, isEncryptedTokenEnvelope } = require('./token-crypto');

// This is deliberately an explicit manifest.  Account deletion is one of the few places
// where "find every table that happens to contain user_id" is not clever: it is how a new
// table becomes an undeleted privacy leak.  The migration auditor below is test-only; the
// running service never reads SQL.
const USER_DATA_RESOURCES = Object.freeze([
  // The account row is last on deletion and is not allowed to carry authentication secrets
  // into an export.
  { name: 'users', ownership: { kind: 'direct', column: 'user_id' }, deletionOrder: -1000, secretColumns: ['password_hash', 'token_version'] },
  { name: 'conversations', ownership: direct(), deletionOrder: 700 },
  { name: 'memories', ownership: direct(), deletionOrder: 690 },
  { name: 'action_log', ownership: direct(), deletionOrder: 680, structuredColumns: ['action', 'result'], redactionColumns: ['action (nested secrets)', 'result (nested secrets)'] },
  { name: 'connectors', ownership: direct(), deletionOrder: 670, secretColumns: ['tokens'] },
  { name: 'telegram_bot_links', ownership: direct(), deletionOrder: 668 },
  // Short-lived, single-use linking tokens. Excluded from export (nothing a user would ever
  // want back — it's a spent or expiring secret, not a record of anything), but still deleted.
  { name: 'telegram_bot_link_tokens', ownership: direct(), deletionOrder: 667, export: 'exclude', excludeReason: 'one-time linking secret', secretColumns: ['token'] },
  { name: 'preferences', ownership: direct(), deletionOrder: 660, jsonColumns: ['value'], redactionColumns: ['value (structured secrets)'] },
  { name: 'devices', ownership: direct(), deletionOrder: 650, secretColumns: ['push_token'] },
  { name: 'paired_displays', ownership: direct(), deletionOrder: 648, secretColumns: ['token_hash'] },
  { name: 'display_pairing_challenges', ownership: direct(), deletionOrder: 647, export: 'exclude', excludeReason: 'one-time pairing secret', secretColumns: ['code_hash'] },
  { name: 'display_render_events', ownership: direct(), deletionOrder: 646 },
  { name: 'native_context', ownership: direct(), deletionOrder: 640 },
  { name: 'briefings', ownership: direct(), deletionOrder: 630 },
  { name: 'scheduled_tasks', ownership: direct(), deletionOrder: 620 },
  { name: 'agent_imports', ownership: direct(), deletionOrder: 610 },
  { name: 'agent_tasks', ownership: direct(), deletionOrder: 580 },
  { name: 'agent_traces', ownership: direct(), deletionOrder: 900 },
  { name: 'simulation_runs', ownership: direct(), deletionOrder: 600 },
  { name: 'agent_runtime_sessions', ownership: direct(), deletionOrder: 570 },
  { name: 'agent_runtime_artifacts', ownership: direct(), deletionOrder: 910 },
  { name: 'agent_runtime_approvals', ownership: direct(), deletionOrder: 920 },
  { name: 'agent_workspaces', ownership: direct(), deletionOrder: 520 },
  { name: 'agent_workspace_files', ownership: direct(), deletionOrder: 940 },
  { name: 'agent_workspace_sessions', ownership: direct(), deletionOrder: 930 },
  { name: 'browser_sessions', ownership: direct(), deletionOrder: 560, secretColumns: ['storage_state'] },
  { name: 'browser_session_events', ownership: direct(), deletionOrder: 550 },
  { name: 'task_steps', ownership: direct(), deletionOrder: 540 },
  { name: 'routines', ownership: direct(), deletionOrder: 530 },
  { name: 'vault_credentials', ownership: direct(), deletionOrder: 950, secretColumns: ['tokens'] },
  // The log is deleted before the grants it points at. Both are account-owned: a record of
  // which sites the agent signed into is exactly the kind of thing an export must include
  // and a deletion must not leave behind.
  { name: 'credential_use_log', ownership: direct(), deletionOrder: 952 },
  { name: 'credential_grants', ownership: direct(), deletionOrder: 415 },
  { name: 'task_entities', ownership: direct(), deletionOrder: 535 },
  { name: 'chat_settings', ownership: direct(), deletionOrder: 510 },
  { name: 'commitments', ownership: direct(), deletionOrder: 500 },
  { name: 'millie_identities', ownership: direct(), deletionOrder: 300 },
  { name: 'millie_identity_handles', ownership: parent('millie_identities', 'id', 'millie_identity_id'), deletionOrder: 980 },
  { name: 'participants', ownership: direct(), deletionOrder: 290 },
  { name: 'participant_addresses', ownership: parent('participants', 'id', 'participant_id'), deletionOrder: 970 },
  { name: 'external_conversations', ownership: direct(), deletionOrder: 280 },
  { name: 'external_conversation_events', ownership: parent('external_conversations', 'id', 'conversation_id'), deletionOrder: 990, contentColumn: 'body_encrypted', secretColumns: ['raw_provider_payload'] },
  { name: 'person_facts', ownership: direct(), deletionOrder: 480 },
  { name: 'occasions', ownership: direct(), deletionOrder: 470 },
  { name: 'notification_events', ownership: direct(), deletionOrder: 460 },
  { name: 'purchases', ownership: direct(), deletionOrder: 450 },
  { name: 'user_subscriptions', ownership: direct(), deletionOrder: 440 },
  { name: 'travel_sessions', ownership: direct(), deletionOrder: 430 },
  { name: 'travel_preferences', ownership: direct(), deletionOrder: 420 },
  { name: 'workflows', ownership: direct(), deletionOrder: 270 },
  { name: 'workflow_events', ownership: parent('workflows', 'id', 'workflow_id'), deletionOrder: 960 },
  { name: 'workflow_checkpoints', ownership: parent('workflows', 'id', 'workflow_id'), deletionOrder: 955 },
  { name: 'workflow_links', ownership: parent('workflows', 'id', 'workflow_id'), deletionOrder: 950 },
  { name: 'documents', ownership: direct(), deletionOrder: 250, storage: { bucket: 'documents', pathColumn: 'storage_path' }, secretColumns: ['storage_path', 'extracted_encrypted'] },
  { name: 'document_representations', ownership: parent('documents', 'id', 'document_id'), deletionOrder: 995, contentColumn: 'content_encrypted' },
  // This is user-owned transient authentication material.  It is deleted, but only its
  // existence/count is reported in the manifest; the token itself is never exported.
  { name: 'password_reset_tokens', ownership: direct(), deletionOrder: 960, export: 'exclude', excludeReason: 'authentication secret' , secretColumns: ['token'] },

  // Explicitly global/system-owned.  They are covered by the manifest auditor but never
  // read, exported, or deleted as part of an account operation.
  { name: 'rate_limits', ownership: { kind: 'global', reason: 'process-wide abuse-control state; not owned by an account' }, export: 'exclude', excludeReason: 'global/system state' },
  { name: 'browser_fastpaths', ownership: { kind: 'global', reason: 'shared host optimisation learned across accounts' }, export: 'exclude', excludeReason: 'global/system state' },
  { name: 'browser_learned_recipes', ownership: { kind: 'global', reason: 'shared host recipe knowledge' }, export: 'exclude', excludeReason: 'global/system state' }
]);

function direct(column = 'user_id') {
  return { kind: 'direct', column };
}

function parent(parentTable, parentColumn, foreignColumn) {
  return { kind: 'parent', parentTable, parentColumn, foreignColumn };
}

const SECRET_KEY = /(?:password|secret|token|cookie|storage_state|authorization|credential|ciphertext|access[_-]?key|private[_-]?key|session[_-]?material)/i;
const SECRET_COLUMNS = new Set([
  'password_hash', 'token_version', 'token', 'tokens', 'storage_state', 'push_token',
  'raw_provider_payload', 'content_encrypted', 'body_encrypted', 'extracted_encrypted',
  'ciphertext', 'authorization', 'access_token', 'refresh_token'
]);
const RESOURCE_PAGE_SIZE = 1000;
const RESOURCE_BATCH_SIZE = 500;

function batches(values, size = RESOURCE_BATCH_SIZE) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

class UserDataLifecycleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UserDataLifecycleError';
    this.code = details.code || 'USER_DATA_LIFECYCLE_FAILED';
    this.details = details;
  }
}

function validateRegistry(resources = USER_DATA_RESOURCES) {
  const seen = new Set();
  for (const resource of resources) {
    if (!resource?.name || seen.has(resource.name)) {
      throw new Error(`Duplicate or invalid user-data resource: ${resource?.name || '<unknown>'}`);
    }
    seen.add(resource.name);
    if (!resource.ownership?.kind) throw new Error(`Missing ownership for ${resource.name}`);
    if (resource.ownership.kind === 'direct' && !resource.ownership.column) {
      throw new Error(`Missing direct ownership column for ${resource.name}`);
    }
    if (resource.ownership.kind === 'parent' && !seen.has(resource.ownership.parentTable) && !resources.some(r => r.name === resource.ownership.parentTable)) {
      throw new Error(`Unknown parent ${resource.ownership.parentTable} for ${resource.name}`);
    }
    if (resource.ownership.kind === 'global' && !resource.ownership.reason) {
      throw new Error(`Global resource ${resource.name} needs an exclusion reason`);
    }
  }
  for (const resource of resources) {
    if (resource.ownership.kind === 'parent' && !seen.has(resource.ownership.parentTable)) {
      throw new Error(`Broken parent dependency for ${resource.name}`);
    }
  }
  const parentGraph = new Map(resources.filter(resource => resource.ownership.kind === 'parent').map(resource => [resource.name, resource.ownership.parentTable]));
  for (const start of parentGraph.keys()) {
    const path = new Set();
    let current = start;
    while (parentGraph.has(current)) {
      if (path.has(current)) throw new Error(`Parent ownership cycle detected at ${current}`);
      path.add(current);
      current = parentGraph.get(current);
    }
  }
  return true;
}

validateRegistry();

function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
}

function splitSqlColumns(body) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === quote && body[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (body.slice(start).trim()) parts.push(body.slice(start).trim());
  return parts;
}

function parseForeignKeys(columns) {
  const fks = [];
  for (const definition of columns) {
    const inline = definition.match(/^["`]?([a-zA-Z_][\w]*)["`]?[^\n]*?\breferences\s+["`]?([a-zA-Z_][\w]*)["`]?\s*\(\s*["`]?([a-zA-Z_][\w]*)/i);
    if (inline) fks.push({ column: inline[1], parentTable: inline[2], parentColumn: inline[3] });
    const tableConstraint = definition.match(/\bforeign\s+key\s*\(\s*["`]?([a-zA-Z_][\w]*)["`]?\s*\)\s*references\s+["`]?([a-zA-Z_][\w]*)["`]?\s*\(\s*["`]?([a-zA-Z_][\w]*)/i);
    if (tableConstraint) fks.push({ column: tableConstraint[1], parentTable: tableConstraint[2], parentColumn: tableConstraint[3] });
  }
  return fks;
}

function parseMigrationDeclarations(sql) {
  const source = stripSqlComments(sql);
  const declarations = [];
  const pattern = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([a-zA-Z_][\w]*)["`]?\s*\(([^;]*?)\);/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const columnDefinitions = splitSqlColumns(match[2]);
    const columns = columnDefinitions
      .map(definition => definition.match(/^["`]?([a-zA-Z_][\w]*)["`]?/))
      .filter(Boolean)
      .map(item => item[1]);
    const foreignKeys = parseForeignKeys(columnDefinitions);
    declarations.push({
      name: match[1],
      columns,
      hasDirectUserColumn: columns.includes('user_id'),
      foreignKeys,
      references: foreignKeys.map(foreignKey => foreignKey.parentTable)
    });
  }
  return declarations;
}

function auditMigrationCoverage({ migrationSql = [], resources = USER_DATA_RESOURCES } = {}) {
  validateRegistry(resources);
  const declarations = migrationSql.flatMap(item => parseMigrationDeclarations(typeof item === 'string' ? item : item.sql));
  const tables = new Set(declarations.map(declaration => declaration.name));
  const registered = new Map(resources.map(resource => [resource.name, resource]));
  const missing = [...tables].filter(table => !registered.has(table));
  const stale = [...registered.keys()].filter(table => !tables.has(table));
  const duplicateRegistry = resources.length - new Set(resources.map(resource => resource.name)).size;
  const brokenParents = resources
    .filter(resource => resource.ownership.kind === 'parent' && !registered.has(resource.ownership.parentTable))
    .map(resource => `${resource.name}->${resource.ownership.parentTable}`);
  const declarationsByName = new Map();
  for (const declaration of declarations) {
    if (!declarationsByName.has(declaration.name)) declarationsByName.set(declaration.name, []);
    declarationsByName.get(declaration.name).push(declaration);
  }
  const ownershipErrors = [];
  for (const resource of resources) {
    const versions = declarationsByName.get(resource.name) || [];
    if (resource.ownership.kind === 'direct' && !versions.some(version => version.columns.includes(resource.ownership.column))) {
      ownershipErrors.push(`${resource.name} does not declare direct ownership column ${resource.ownership.column}`);
    }
    if (resource.ownership.kind === 'parent' && !versions.some(version => version.foreignKeys.some(foreignKey => (
      foreignKey.column === resource.ownership.foreignColumn
      && foreignKey.parentTable === resource.ownership.parentTable
      && foreignKey.parentColumn === resource.ownership.parentColumn
    )))) {
      ownershipErrors.push(`${resource.name} does not declare FK ${resource.ownership.foreignColumn}->${resource.ownership.parentTable}.${resource.ownership.parentColumn}`);
    }
    if (resource.ownership.kind === 'global' && versions.some(version => version.hasDirectUserColumn)) {
      ownershipErrors.push(`${resource.name} is global but declares direct user ownership`);
    }
  }
  const parentGraph = new Map();
  for (const resource of resources) {
    if (resource.ownership.kind === 'parent') parentGraph.set(resource.name, resource.ownership.parentTable);
  }
  const cycleNodes = [];
  for (const start of parentGraph.keys()) {
    const path = new Set();
    let current = start;
    while (parentGraph.has(current)) {
      if (path.has(current)) { cycleNodes.push(current); break; }
      path.add(current);
      current = parentGraph.get(current);
    }
  }
  const directOwnedNames = new Set(resources.filter(resource => resource.ownership.kind === 'direct').map(resource => resource.name));
  function reachesDirectOwner(table, visited = new Set()) {
    if (directOwnedNames.has(table)) return true;
    if (visited.has(table)) return false;
    visited.add(table);
    return (declarationsByName.get(table) || []).some(version => version.foreignKeys.some(foreignKey => reachesDirectOwner(foreignKey.parentTable, new Set(visited))));
  }
  for (const resource of resources.filter(item => item.ownership.kind === 'global')) {
    if (reachesDirectOwner(resource.name)) ownershipErrors.push(`${resource.name} is global but transitively references a user-owned table`);
  }
  const result = { declarations, missing, stale, duplicateRegistry, brokenParents, ownershipErrors, cycleNodes };
  if (missing.length || stale.length || duplicateRegistry || brokenParents.length || ownershipErrors.length || cycleNodes.length) {
    throw new Error(`User-data migration coverage failed: ${JSON.stringify({ missing, stale, duplicateRegistry, brokenParents, ownershipErrors, cycleNodes })}`);
  }
  return result;
}

// The auditor above only proves the manifest agrees with the SQL files sitting on disk.
// It cannot see production.  On 2026-08-24 both agreed perfectly while the live database
// was missing six declared tables, so every account deletion returned a 500 and the test
// suite stayed green throughout.  This auditor closes that gap: it compares the manifest
// against the tables that actually exist, in both directions.
function auditLiveSchema({ liveTables = [], resources = USER_DATA_RESOURCES, ignore = [] } = {}) {
  validateRegistry(resources);
  const live = new Set(liveTables);
  const ignored = new Set(ignore);
  const registered = new Set(resources.map(resource => resource.name));
  // Declared but not present: export and deletion fail for every real account.
  const absent = [...registered].filter(name => !live.has(name));
  // Present but undeclared: nothing exports or deletes it, so any user data inside is
  // stranded indefinitely -- exactly what a retired feature's leftover table does.
  const unregistered = [...live].filter(name => !registered.has(name) && !ignored.has(name));
  const result = { absent, unregistered, checked: live.size };
  if (absent.length || unregistered.length) {
    throw new Error(`Live schema does not match the user-data manifest: ${JSON.stringify({ absent, unregistered })}`);
  }
  return result;
}

function redactValue(value, key = '') {
  if (SECRET_COLUMNS.has(key) || (key && SECRET_KEY.test(key))) return undefined;
  // Never leak a partial authenticated envelope from a generic JSON column.  Content-bearing
  // columns are handled separately by safeExportRow, which decrypts them before this helper
  // is involved.
  if (isEncryptedTokenEnvelope(value) || (value && typeof value === 'object' && value.encrypted === true)) return undefined;
  if (Array.isArray(value)) return value.map(item => redactValue(item)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const safe = redactValue(childValue, childKey);
    if (safe !== undefined) output[childKey] = safe;
  }
  return output;
}

function decryptContent(value, resourceName, id) {
  if (value == null) return null;
  try {
    // decryptTokens deliberately handles legacy plaintext values, while encrypted envelopes
    // require the configured key and authenticate before any content leaves the service.
    return decryptTokens(value);
  } catch (error) {
    throw new UserDataLifecycleError(`Could not decrypt ${resourceName} content for export`, {
      code: 'EXPORT_DECRYPT_FAILED', resource: resourceName, rowId: id, cause: error
    });
  }
}

function parseStructuredValue(value, resourceName, column, id, { strict = true } = {}) {
  if (value == null || typeof value !== 'string') return redactValue(value);
  try {
    return redactValue(JSON.parse(value));
  } catch (error) {
    if (!strict && !/^[\s]*[\[{]/.test(value)) return value;
    throw new UserDataLifecycleError(`Could not parse ${resourceName}.${column} for export`, {
      code: 'EXPORT_STRUCTURED_PARSE_FAILED', resource: resourceName, column, rowId: id, cause: error
    });
  }
}

function safeExportRow(resource, row) {
  const output = {};
  const secretColumns = new Set(resource.secretColumns || []);
  const structuredColumns = new Set(resource.structuredColumns || []);
  const jsonColumns = new Set(resource.jsonColumns || []);
  for (const [key, value] of Object.entries(row || {})) {
    if (key === '__signedUrl') continue;
    if (structuredColumns.has(key)) {
      output[key] = parseStructuredValue(value, resource.name, key, row.id);
      continue;
    }
    if (jsonColumns.has(key)) {
      output[key] = parseStructuredValue(value, resource.name, key, row.id, { strict: false });
      continue;
    }
    if (secretColumns.has(key) || SECRET_COLUMNS.has(key) || SECRET_KEY.test(key)) {
      if (key === 'tokens' && value != null) output.hasTokens = true;
      continue;
    }
    output[key] = redactValue(value, key);
  }
  if (resource.contentColumn && row?.[resource.contentColumn] != null) {
    output.content = decryptContent(row[resource.contentColumn], resource.name, row.id);
  }
  if (resource.name === 'documents' && row?.extracted_encrypted != null) {
    output.content = decryptContent(row.extracted_encrypted, resource.name, row.id);
  }
  return output;
}

function queryRows(db, resource, userId, parentRowsByName, parentIdsOverride = null) {
  let query = db.from(resource.name).select('*');
  if (resource.ownership.kind === 'direct') return query.eq(resource.ownership.column, userId);
  if (resource.ownership.kind !== 'parent') throw new UserDataLifecycleError(`Cannot query global resource ${resource.name}`);
  const parents = parentRowsByName.get(resource.ownership.parentTable) || [];
  const ids = parentIdsOverride || parents.map(row => row[resource.ownership.parentColumn]).filter(value => value != null);
  return ids.length ? query.in(resource.ownership.foreignColumn, ids) : null;
}

async function readResourceRows(db, resource, userId, cache, resourceByName) {
  if (cache.has(resource.name)) return cache.get(resource.name);
  const parentRows = new Map();
  if (resource.ownership.kind === 'parent') {
    const parent = resourceByName.get(resource.ownership.parentTable);
    if (!parent) throw new UserDataLifecycleError(`Cannot resolve parent resource ${resource.ownership.parentTable}`);
    const rows = await readResourceRows(db, parent, userId, cache, resourceByName);
    parentRows.set(parent.name, rows);
  }
  const rows = [];
  const parentIds = resource.ownership.kind === 'parent'
    ? [...(parentRows.get(resource.ownership.parentTable) || [])].map(row => row[resource.ownership.parentColumn]).filter(value => value != null)
    : null;
  const idBatches = parentIds ? batches(parentIds) : [null];
  for (const parentIdsBatch of idBatches) {
    const firstQuery = queryRows(db, resource, userId, parentRows, parentIdsBatch);
    if (!firstQuery) continue;
    let offset = 0;
    for (;;) {
      // Supabase's REST layer caps an unbounded select.  Rebuild the ownership query for each
      // page so exports cannot quietly omit the user's older history or child rows.
      const query = offset === 0 ? firstQuery : queryRows(db, resource, userId, parentRows, parentIdsBatch);
      if (typeof query.range === 'function') query.range(offset, offset + RESOURCE_PAGE_SIZE - 1);
      const { data, error } = await query;
      if (error) throw new UserDataLifecycleError(`Could not read ${resource.name}`, { code: 'RESOURCE_READ_FAILED', resource: resource.name, cause: error });
      const page = data || [];
      rows.push(...page);
      if (typeof query.range !== 'function' || page.length < RESOURCE_PAGE_SIZE) break;
      offset += RESOURCE_PAGE_SIZE;
    }
  }
  cache.set(resource.name, rows);
  return rows;
}

function manifestFor(resources, rowMap) {
  return {
    schemaVersion: 1,
    included: resources.filter(resource => resource.ownership.kind !== 'global' && resource.export !== 'exclude')
      .map(resource => ({ resource: resource.name, count: (rowMap.get(resource.name) || []).length })),
    excluded: resources.filter(resource => resource.ownership.kind === 'global' || resource.export === 'exclude')
      .map(resource => ({ resource: resource.name, count: (rowMap.get(resource.name) || []).length, reason: resource.excludeReason || resource.ownership.reason || 'excluded by policy' })),
    redactions: resources.flatMap(resource => [...(resource.secretColumns || []), ...(resource.redactionColumns || [])].map(column => ({
      resource: resource.name,
      column,
      reason: 'secret policy'
    })))
  };
}

function normalizeSignedUrl(result, resourceName) {
  if (result?.error) throw new UserDataLifecycleError(`Could not sign ${resourceName} download`, { code: 'EXPORT_SIGN_FAILED', resource: resourceName, cause: result.error });
  const signedUrl = typeof result === 'string' ? result : result?.signedUrl || result?.data?.signedUrl;
  if (!signedUrl) throw new UserDataLifecycleError(`Could not sign ${resourceName} download`, { code: 'EXPORT_SIGN_FAILED', resource: resourceName });
  return signedUrl;
}

function createActionableResourceMap(resources, rowsByName) {
  const result = new Map();
  for (const resource of resources) {
    if (resource.ownership.kind === 'global' || resource.export === 'exclude') continue;
    result.set(resource.name, (rowsByName.get(resource.name) || []).map(row => safeExportRow(resource, row)));
  }
  return result;
}

function compatibilityExport(data, manifest, userId) {
  return {
    exportedAt: new Date().toISOString(),
    userId,
    user: data.users?.[0] || null,
    conversations: data.conversations || [],
    memories: data.memories || [],
    actionLog: (data.action_log || []).map(row => ({ ...row, action: typeof row.action === 'string' ? safeParse(row.action) : row.action })),
    connectors: data.connectors || [],
    preferences: data.preferences || [],
    devices: data.devices || [],
    nativeContext: data.native_context || [],
    briefings: data.briefings || [],
    agentTasks: data.agent_tasks || [],
    agentTraces: data.agent_traces || [],
    simulationRuns: data.simulation_runs || [],
    workspace: {
      workspaces: data.agent_workspaces || [],
      files: data.agent_workspace_files || [],
      sessions: data.agent_workspace_sessions || []
    },
    continuityImports: data.agent_imports || [],
    // New complete surface.  The compatibility keys above stay stable for old clients.
    resources: data,
    exportManifest: { ...manifest, generatedAt: new Date().toISOString() }
  };
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function createUserDataLifecycle({ db, storage = null, clearCaches = () => {}, signUrl = null, signedUrlTtlSeconds = 15 * 60, resources = USER_DATA_RESOURCES } = {}) {
  if (!db || typeof db.from !== 'function') throw new TypeError('createUserDataLifecycle requires a database client');
  validateRegistry(resources);
  const resourceByName = new Map(resources.map(resource => [resource.name, resource]));
  const objectStorage = storage || db.storage;
  const signDocumentUrl = signUrl || (objectStorage?.from
    ? (storagePath, expiresInSeconds, resource) => objectStorage.from(resource.storage.bucket).createSignedUrl(storagePath, expiresInSeconds)
    : null);

  async function exportUserData(userId) {
    const rowsByName = new Map();
    for (const resource of resources) {
      if (resource.ownership.kind === 'global') continue;
      await readResourceRows(db, resource, userId, rowsByName, resourceByName);
    }
    const documents = resources.find(resource => resource.name === 'documents');
    if (documents) {
      const rows = rowsByName.get('documents') || [];
      for (const row of rows) {
        if (!row.storage_path) continue;
        let result;
        try {
          if (!signDocumentUrl) throw new Error('Document storage signing is unavailable');
          result = await signDocumentUrl(row.storage_path, signedUrlTtlSeconds, documents);
        } catch (error) {
          throw new UserDataLifecycleError('Could not sign a document download', { code: 'EXPORT_SIGN_FAILED', resource: 'documents', cause: error });
        }
        row.__signedUrl = normalizeSignedUrl(result, 'document');
      }
    }
    const dataMap = createActionableResourceMap(resources, rowsByName);
    const documentData = dataMap.get('documents') || [];
    documentData.forEach((row, index) => {
      const source = rowsByName.get('documents')?.[index];
      if (source?.__signedUrl) row.downloadUrl = source.__signedUrl;
    });
    const manifest = manifestFor(resources, rowsByName);
    return compatibilityExport(Object.fromEntries(dataMap), manifest, userId);
  }

  async function removeBlobObjects(userId, rowsByName) {
    const documents = resources.find(resource => resource.name === 'documents');
    if (!documents?.storage) return;
    const paths = (rowsByName.get(documents.name) || []).map(row => row[documents.storage.pathColumn]).filter(Boolean);
    if (!paths.length) return;
    if (!objectStorage?.from) throw new UserDataLifecycleError('Document storage is unavailable; account deletion is incomplete', { code: 'DELETE_STORAGE_UNAVAILABLE', resource: documents.name, incomplete: true });
    try {
      for (const pathBatch of batches(paths)) {
        const result = await objectStorage.from(documents.storage.bucket).remove(pathBatch);
        if (result?.error) throw result.error;
      }
    } catch (error) {
      throw new UserDataLifecycleError('Could not remove account document storage', {
        code: 'DELETE_STORAGE_FAILED', resource: documents.name, cause: error, incomplete: true
      });
    }
  }

  async function deleteResourceRows(resource, userId, rowsByName) {
    let query = db.from(resource.name).delete();
    if (resource.ownership.kind === 'direct') {
      query = query.eq(resource.ownership.column, userId);
    } else if (resource.ownership.kind === 'parent') {
      const parentRows = rowsByName.get(resource.ownership.parentTable) || [];
      const ids = parentRows.map(row => row[resource.ownership.parentColumn]).filter(value => value != null);
      if (!ids.length) return false;
      for (const idBatch of batches(ids)) {
        const parentQuery = db.from(resource.name).delete().in(resource.ownership.foreignColumn, idBatch);
        const result = await parentQuery;
        if (result?.error) throw new UserDataLifecycleError(`Could not delete ${resource.name}`, { code: 'DELETE_RESOURCE_FAILED', resource: resource.name, cause: result.error });
      }
      return true;
    } else {
      return 0;
    }
    const result = await query;
    if (result?.error) throw new UserDataLifecycleError(`Could not delete ${resource.name}`, { code: 'DELETE_RESOURCE_FAILED', resource: resource.name, cause: result.error });
    return true;
  }

  async function deleteUserData(userId) {
    // Read every owned resource before the first mutation.  This both makes the dependency
    // plan deterministic and ensures a missing table/query error cannot masquerade as a
    // successful partial deletion.
    const rowsByName = new Map();
    for (const resource of resources) {
      if (resource.ownership.kind === 'global') continue;
      await readResourceRows(db, resource, userId, rowsByName, resourceByName);
    }
    await removeBlobObjects(userId, rowsByName);
    const ordered = resources
      .filter(resource => resource.ownership.kind !== 'global')
      .slice()
      .sort((left, right) => (right.deletionOrder || 0) - (left.deletionOrder || 0));
    const deletedResources = [];
    try {
      for (const resource of ordered) {
        if (await deleteResourceRows(resource, userId, rowsByName)) deletedResources.push(resource.name);
      }
    } catch (error) {
      if (error instanceof UserDataLifecycleError) {
        error.details.deletedResources = deletedResources;
        error.details.incomplete = true;
        throw error;
      }
      throw new UserDataLifecycleError('Account deletion is incomplete', { code: 'DELETE_INCOMPLETE', cause: error, deletedResources, incomplete: true });
    }
    // Local caches must not be cleared until the users row succeeded.  A retry after an
    // injected child failure therefore sees the same cache until the account really ends.
    clearCaches(userId);
    return { success: true, deleted: true, deletedResources };
  }

  return { exportUserData, deleteUserData, resources };
}

function createUserDataRouteHandlers({ lifecycle, requireMatchingUser, logger = console } = {}) {
  if (!lifecycle?.exportUserData || !lifecycle?.deleteUserData) throw new TypeError('createUserDataRouteHandlers requires a lifecycle');
  if (typeof requireMatchingUser !== 'function') throw new TypeError('createUserDataRouteHandlers requires authentication');
  return {
    export: async (req, res) => {
      const { userId } = req.params;
      if (!requireMatchingUser(req, res, userId)) return;
      try {
        const data = await lifecycle.exportUserData(userId);
        res.setHeader('Content-Disposition', 'attachment; filename="milgrain-data-export.json"');
        res.json(data);
      } catch (error) {
        logger.error?.('/user/export error:', error.message);
        res.status(500).json({ error: 'Could not export your data right now.' });
      }
    },
    delete: async (req, res) => {
      const { userId } = req.params;
      if (!requireMatchingUser(req, res, userId)) return;
      try {
        res.json(await lifecycle.deleteUserData(userId));
      } catch (error) {
        logger.error?.('/user/delete error:', error.message);
        res.status(500).json({ error: 'Could not delete your account right now.', success: false, deleted: false, incomplete: true });
      }
    }
  };
}

module.exports = {
  USER_DATA_RESOURCES,
  UserDataLifecycleError,
  auditLiveSchema,
  auditMigrationCoverage,
  createUserDataLifecycle,
  createUserDataRouteHandlers,
  parseMigrationDeclarations,
  redactValue,
  safeExportRow,
  validateRegistry
};
