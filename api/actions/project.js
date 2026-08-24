'use strict';

// Project and workspace actions, lifted out of the switch in api/index.js.
//
// Service modules are required as objects and called as properties rather than
// destructured, so the orchestration tests that monkey-patch methods on the shared module
// object keep working.

const agentProjectRuntime = require('../services/agent-project-runtime');
const agentRuntime = require('../services/agent-runtime');
const agentWorkspace = require('../services/agent-workspace');

// Project work is deliberately a separate adapter from the database-backed scratch
// workspace. It provisions a task-scoped clone from a server-side project catalog and
// exposes only bounded Git/check/write operations; the model never supplies a shell
// command, repository URL, or absolute filesystem path.
async function projectStatus({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
  if (!projectRef) return { success: false, error: 'project_status requires a configured project_ref' };
  if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
  try {
    await bindRuntimeProject(projectRef);
    const status = await agentProjectRuntime.gitStatus(userId, context.persistedTaskId, projectRef);
    return {
      success: true,
      text: `${status.projectName} is on ${status.branch}${status.dirty ? ` with ${status.files.length} changed file${status.files.length === 1 ? '' : 's'}.` : ' with no uncommitted changes.'}`,
      actionSummary: `${status.projectName} status loaded`,
      ...status
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function projectDiff({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
  if (!projectRef) return { success: false, error: 'project_diff requires a configured project_ref' };
  if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
  try {
    await bindRuntimeProject(projectRef);
    const diff = await agentProjectRuntime.gitDiff(userId, context.persistedTaskId, projectRef);
    const hasChanges = Boolean(diff.diff);
    return {
      success: true,
      text: hasChanges ? diff.diff : `${diff.projectName} has no uncommitted changes.`,
      actionSummary: hasChanges ? `${diff.projectName} changes loaded` : 'No project changes',
      ...diff
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function projectWrite({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
  if (!projectRef) return { success: false, error: 'project_write requires a configured project_ref' };
  if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
  if (!params?.path) return { success: false, error: 'project_write requires path' };
  try {
    await bindRuntimeProject(projectRef);
    const file = await agentProjectRuntime.writeProjectFile(
      userId,
      context.persistedTaskId,
      projectRef,
      params.path,
      params.content
    );
    const artifact = await recordProjectArtifact({
      kind: 'file',
      path: file.path,
      title: file.path,
      summary: `Saved ${file.path} in ${file.projectName}.`
    });
    return {
      success: true,
      text: `Saved ${file.path} in ${file.projectName}.`,
      actionSummary: `Saved ${file.path}`,
      projectRef: file.projectRef,
      path: file.path,
      bytes: file.bytes,
      ...(artifact ? { artifact } : {})
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function projectCheck({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
  if (!projectRef) return { success: false, error: 'project_check requires a configured project_ref' };
  if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
  try {
    await bindRuntimeProject(projectRef);
    const check = await agentProjectRuntime.runProjectCheck(
      userId,
      context.persistedTaskId,
      projectRef,
      params?.check || 'test'
    );
    const artifact = await recordProjectArtifact({
      kind: 'test_result',
      title: `${check.projectName} ${check.check} check`,
      summary: check.success
        ? `${check.check} passed for ${check.projectName}.`
        : `${check.check} failed for ${check.projectName}.`,
      status: check.success ? 'created' : 'failed',
      metadata: { check: check.check, exitCode: check.exitCode, timedOut: check.timedOut }
    });
    return {
      success: check.success,
      text: check.success
        ? `${check.projectName} ${check.check} passed.`
        : `${check.projectName} ${check.check} failed.`,
      actionSummary: `${check.check} ${check.success ? 'passed' : 'failed'}`,
      ...check,
      ...(artifact ? { artifact } : {})
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function projectCommit({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
  if (!projectRef) return { success: false, error: 'project_commit requires a configured project_ref' };
  if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
  if (!params?.message) return { success: false, error: 'project_commit requires a concise message' };
  try {
    await bindRuntimeProject(projectRef);
    const commit = await agentProjectRuntime.commitProjectChanges(
      userId,
      context.persistedTaskId,
      projectRef,
      params.message
    );
    const artifact = await recordProjectArtifact({
      kind: 'receipt',
      title: `${commit.projectName} changeset`,
      summary: `Saved ${commit.commit.slice(0, 12)} on ${commit.branch}.`,
      metadata: { commit: commit.commit, branch: commit.branch }
    });
    return {
      success: true,
      text: commit.text,
      actionSummary: 'Project changeset saved',
      ...commit,
      ...(artifact ? { artifact } : {})
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function projectRollback({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
  if (!projectRef) return { success: false, error: 'project_rollback requires a configured project_ref' };
  if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
  try {
    await bindRuntimeProject(projectRef);
    const rollback = await agentProjectRuntime.rollbackProjectChanges(
      userId,
      context.persistedTaskId,
      projectRef
    );
    const artifact = await recordProjectArtifact({
      kind: 'receipt',
      title: `${rollback.projectName} rollback`,
      summary: `Rolled back uncommitted changes on ${rollback.branch}.`,
      metadata: { branch: rollback.branch }
    });
    return {
      success: true,
      text: rollback.text,
      actionSummary: 'Project changes rolled back',
      ...rollback,
      ...(artifact ? { artifact } : {})
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function projectSync({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const projectRef = params?.project_ref || params?.projectRef || context.projectRef;
  if (!projectRef) return { success: false, error: 'project_sync requires a configured project_ref' };
  if (!context.persistedTaskId) return { success: false, error: 'Project work requires a durable task.' };
  try {
    await bindRuntimeProject(projectRef);
    const published = await agentProjectRuntime.publishProjectBranch(
      userId,
      context.persistedTaskId,
      projectRef
    );
    const artifact = await recordProjectArtifact({
      kind: 'receipt',
      title: `${published.projectName} branch synchronized`,
      summary: `Published ${published.branch}.`,
      metadata: { branch: published.branch, published: true }
    });
    return {
      success: true,
      text: published.text,
      actionSummary: 'Project branch synchronized',
      ...published,
      ...(artifact ? { artifact } : {})
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Workspace tools. Path traversal, size and kind are all enforced inside
// agent-workspace.js, and every query is scoped to this user's workspace row, so a
// model-authored path cannot reach another user's files or escape the workspace.
async function workspaceWrite({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const filePath = String(params?.path || '').trim();
  const content = params?.content;
  if (!filePath) return { success: false, error: 'workspace_write requires path' };
  if (typeof content !== 'string') return { success: false, error: 'workspace_write requires content as text' };
  try {
    const runtimeWrite = context.runtimeSessionId && context.persistedTaskId
      ? await agentRuntime.writeFileArtifact(supabase, userId, {
        sessionId: context.runtimeSessionId,
        taskId: context.persistedTaskId,
        path: filePath,
        content,
        kind: params?.kind
      })
      : { file: await agentWorkspace.writeWorkspaceFile(supabase, userId, filePath, content, params?.kind), artifact: null };
    const file = runtimeWrite.file;
    return {
      success: true,
      text: `Saved ${file.path} (v${file.version}).`,
      actionSummary: `Saved ${file.path}`,
      path: file.path,
      version: file.version,
      ...(runtimeWrite.artifact ? { artifact: runtimeWrite.artifact } : {})
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function workspaceRead({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  const filePath = String(params?.path || '').trim();
  if (!filePath) return { success: false, error: 'workspace_read requires path' };
  try {
    const file = await agentWorkspace.readWorkspaceFile(supabase, userId, filePath);
    if (!file) return { success: false, error: `No workspace file at ${filePath}.` };
    return {
      success: true,
      text: file.content,
      actionSummary: `Read ${file.path}`,
      path: file.path,
      version: file.version
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function workspaceList({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, path } = deps;
  const { recordProjectArtifact, bindRuntimeProject } = helpers;
  try {
    const { files } = await agentWorkspace.listWorkspaceFiles(supabase, userId, params?.prefix || '');
    // Paths and sizes only — the agent asks for content it actually needs via
    // workspace_read, rather than every file being replayed into the next prompt.
    const listed = files.map(file => ({ path: file.path, kind: file.kind, bytes: file.size_bytes, updatedAt: file.updated_at }));
    return {
      success: true,
      text: listed.length ? listed.map(f => `${f.path} (${f.bytes} bytes)`).join('\n') : 'The workspace is empty.',
      actionSummary: `${listed.length} file${listed.length === 1 ? '' : 's'} in workspace`,
      files: listed
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  handlers: {
    project_status: projectStatus,
    project_diff: projectDiff,
    project_write: projectWrite,
    project_check: projectCheck,
    project_commit: projectCommit,
    project_rollback: projectRollback,
    project_sync: projectSync,
    workspace_write: workspaceWrite,
    workspace_read: workspaceRead,
    workspace_list: workspaceList
  }
};
