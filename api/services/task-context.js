const CONTINUATION_CUE = /\b(?:continue|resume|keep working|keep going|carry on|pick up|finish|complete|progress|status|update|what happened|handle (?:the|that|this)|work on (?:the|that|this))\b/i;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'for',
  'from', 'get', 'give', 'go', 'have', 'i', 'in', 'is', 'it', 'me', 'my', 'of',
  'on', 'or', 'please', 'the', 'that', 'this', 'to', 'was', 'what', 'with', 'you',
  'your', 'work', 'working', 'thing', 'task', 'project', 'goal', 'now', 'just',
  'keep', 'going', 'continue', 'resume', 'carry', 'pick', 'up', 'finish', 'complete',
  'progress', 'status', 'update', 'happened', 'handle'
]);

function tokens(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length > 2 && !STOP_WORDS.has(token))
  );
}

function taskIsResumable(task) {
  return ['pending', 'paused', 'failed'].includes(String(task?.status || '').toLowerCase())
    && task?.metadata?.awaitingApproval !== true
    && task?.id
    && task?.goal;
}

/*
 * Resolve a follow-up to one durable goal without asking a model to guess task identity.
 * Explicit continuation language is required; an ordinary new request never gets silently
 * attached to an old goal. If several paused goals match equally, return null and let the
 * conversation ask the smallest clarifying question.
 */
function resolveTaskReference(tasks = [], message = '') {
  if (!CONTINUATION_CUE.test(String(message || ''))) return null;
  const requestTokens = tokens(message);
  const candidates = tasks.filter(taskIsResumable).map(task => {
    const goalTokens = tokens(task.goal);
    const overlap = [...requestTokens].filter(token => goalTokens.has(token));
    const score = overlap.reduce((total, token) => total + (token.length >= 7 ? 2 : 1), 0);
    return { task, score, overlap };
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || new Date(b.task.updated_at || b.task.created_at || 0) - new Date(a.task.updated_at || a.task.created_at || 0));
  const best = candidates[0];
  const second = candidates[1];

  // A bare “continue” is safe only when there is exactly one resumable goal. With multiple
  // goals, silently picking the most recent one is how continuity becomes surprising.
  if (best.score === 0) return candidates.length === 1 ? best.task : null;
  if (second && second.score === best.score) return null;
  return best.task;
}

module.exports = {
  CONTINUATION_CUE,
  resolveTaskReference,
  taskIsResumable,
  tokens
};
