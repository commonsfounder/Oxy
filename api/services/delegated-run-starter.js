'use strict';

// One starter for every user-visible durable run. Creating an agent_tasks row is
// persistence; this boundary is what turns that row into actual work. Keeping the
// claim, runtime session, model route, and background loop together prevents callers
// from quietly implementing their own half-started variants.

function resolveDelegatedGuardMode(requested, inherited) {
  if (inherited === true || requested === true) return true;
  return typeof requested === 'boolean' ? requested : undefined;
}

function createDelegatedRunStarter({
  lifecycle,
  routeHandlers,
  ensureRuntime,
  resolveRoute,
  buildSystemPrompt,
  runLoop,
  executeActions,
  logger = console
} = {}) {
  if (!lifecycle || typeof lifecycle.get !== 'function' || typeof lifecycle.updateControls !== 'function') {
    throw new TypeError('createDelegatedRunStarter requires a lifecycle');
  }
  if (!routeHandlers || typeof routeHandlers.run !== 'function') {
    throw new TypeError('createDelegatedRunStarter requires route handlers');
  }
  if (typeof ensureRuntime !== 'function' || typeof resolveRoute !== 'function' || typeof buildSystemPrompt !== 'function') {
    throw new TypeError('createDelegatedRunStarter requires runtime, route, and prompt functions');
  }
  if (typeof runLoop !== 'function' || typeof executeActions !== 'function') {
    throw new TypeError('createDelegatedRunStarter requires a loop and action executor');
  }

  return {
    async start({ userId, task, runtime = {}, awaitLoop = false } = {}) {
      if (!task?.id) return { status: 404, body: { error: 'Not found' } };
      if (task.metadata?.awaitingApproval === true) {
        return {
          status: 409,
          body: { error: 'That task is waiting for your approval.', awaitingApproval: true, taskId: task.id }
        };
      }

      const resuming = Boolean(task.checkpoint);
      const runtimeOptions = {
        deviceId: runtime.deviceId || task.metadata?.deviceId,
        deviceType: runtime.deviceType || task.metadata?.deviceType || 'ambient_home',
        projectRef: runtime.projectRef || task.metadata?.projectRef,
        kind: runtime.kind || task.metadata?.runtimeKind || 'task'
      };

      let claimedTask;
      try {
        const startResult = await routeHandlers.run({
          userId,
          taskId: task.id,
          task,
          runtime: runtimeOptions
        });
        if (startResult.status !== 200) return startResult;
        // The CAS claim is the authoritative hand-off. The route seam returns the
        // claimed row directly; re-reading here could fail after a successful claim
        // and strand a running task with no owner attempt available for repair.
        claimedTask = startResult.claimed || null;
      } catch (error) {
        logger.error?.('[delegated-run] claim failed:', error?.message || error);
        return { status: 503, body: { error: 'Could not start the work session.' } };
      }

      if (!claimedTask) {
        return { status: 503, body: { error: 'Could not start the work session.' } };
      }

      let runtimeSession;
      let route;
      try {
        runtimeSession = await ensureRuntime(userId, claimedTask, runtimeOptions);
        route = await resolveRoute(userId, claimedTask);
        await lifecycle.updateControls(userId, claimedTask.id, {
          metadata: {
            modelRoute: route,
            runtimeSessionId: runtimeSession.id
          }
        });
        if (typeof lifecycle.assertOwner === 'function') {
          const fenced = await lifecycle.assertOwner(userId, claimedTask.id, claimedTask.attempt);
          if (!fenced) return { status: 409, body: { error: 'That task was stopped before it could run.', taskId: claimedTask.id } };
          claimedTask = fenced;
        }
      } catch (error) {
        await lifecycle.interrupt?.(userId, claimedTask.id, 'The work session could not be started.', {
          ownerAttempt: claimedTask.attempt
        }).catch?.(() => {});
        logger.error?.('[delegated-run] runtime setup failed:', error?.message || error);
        return { status: 503, body: { error: 'Could not start the work session.' } };
      }

      const run = Promise.resolve(buildSystemPrompt(userId))
        .then(dynamicSystemPrompt => runLoop({
          userId,
          initialMessage: claimedTask.goal,
          dynamicSystemPrompt,
          provider: route.provider,
          modelName: route.model,
          maxIterations: Number.isFinite(claimedTask.checkpoint?.maxIterations)
            ? claimedTask.checkpoint.maxIterations
            : 6,
          context: {
            autonomy: claimedTask.autonomy,
            guardMode: claimedTask.metadata?.guardMode === true,
            modelRoute: route,
            runtimeSessionId: runtimeSession.id
          },
          executeActionsFn: executeActions,
          persistTask: true,
          existingTaskId: claimedTask.id
        }));
      const guardedRun = run.catch(async error => {
          if (error?.authoritativeSaved) {
            await lifecycle.repairProjection?.(userId, claimedTask.id).catch?.(() => {});
          } else {
            await lifecycle.interrupt?.(userId, claimedTask.id, error, { ownerAttempt: claimedTask.attempt }).catch?.(() => {});
          }
        });

      // On the long-lived application process this hands the loop off after the
      // durable claim and runtime setup, keeping the request responsive.
      if (awaitLoop) await guardedRun;

      return {
        status: 200,
        body: { started: !awaitLoop, queued: false, resumed: resuming, taskId: claimedTask.id }
      };
    }
  };
}

module.exports = { createDelegatedRunStarter, resolveDelegatedGuardMode };
