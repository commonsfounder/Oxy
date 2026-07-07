-- Purge leaked internal agent trace strings from the user-facing memories table.
-- These were written by the (now removed) episodic agent memory call at
-- api/index.js — they should never have been user-visible. See Memory trust plan.

DELETE FROM memories WHERE source = 'agent_episodic';
DELETE FROM memories WHERE content LIKE 'Agent handled goal ~%';
