'use strict';

// Adam's heartbeat: runs the proactive sweep (reminders, watches, briefings, deliveries) on a timer.
// Off unless OXY_HEARTBEAT=on, so a laptop running the server never sweeps the live database.

const DEFAULT_INTERVAL_MINUTES = 5;
const FIRST_RUN_DELAY_MS = 60 * 1000;

function heartbeatSettings(env = process.env) {
  const enabled = String(env.OXY_HEARTBEAT || '').toLowerCase() === 'on';
  const minutes = Number(env.OXY_HEARTBEAT_MINUTES);
  const intervalMinutes = Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_INTERVAL_MINUTES;
  return { enabled, intervalMs: intervalMinutes * 60 * 1000 };
}

function startHeartbeat({
  sweep,
  intervalMs = DEFAULT_INTERVAL_MINUTES * 60 * 1000,
  firstRunDelayMs = FIRST_RUN_DELAY_MS,
  logger = console,
  timers = { setTimeout, setInterval, clearTimeout, clearInterval }
} = {}) {
  let running = false;

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      const summary = await sweep(logger);
      logger.log?.(`[heartbeat] ${JSON.stringify(summary)}`);
      return { summary };
    } catch (error) {
      logger.error?.(`[heartbeat] sweep failed: ${error.message}`);
      return { error };
    } finally {
      running = false;
    }
  }

  const first = timers.setTimeout(tick, firstRunDelayMs);
  const repeat = timers.setInterval(tick, intervalMs);
  first.unref?.();
  repeat.unref?.();

  return { tick, stop() { timers.clearTimeout(first); timers.clearInterval(repeat); } };
}

module.exports = { heartbeatSettings, startHeartbeat, DEFAULT_INTERVAL_MINUTES };
