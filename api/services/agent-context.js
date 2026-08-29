const DEFAULT_AGENT_IDENTITY = {
  name: 'Adam',
  role: 'personal agent',
  continuity: 'persistent'
};

const SAFE_PREFERENCE_KEYS = new Set([
  'autonomy',
  'chat_effort',
  'preferred_maps_app',
  'preferred_transport_mode',
  'proactive_briefings',
  'health_alerts',
  'location_reminders',
  'assistant_name',
  'assistant_voice',
  'user_name'
]);

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function profileSections(profileText) {
  const sections = {
    identity: [],
    work: [],
    relationships: [],
    goals: [],
    context: []
  };
  const lines = String(profileText || '')
    .split(/\r?\n|;+/)
    .map(normalizeText)
    .filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();
    const key = /\b(name|live|lives|based|from|identity|age)\b/.test(lower)
      ? 'identity'
      : /\b(work|works|company|startup|building|project|job|role)\b/.test(lower)
        ? 'work'
        : /\b(wife|husband|partner|kids?|family|boss|friend|relationships?)\b/.test(lower)
          ? 'relationships'
          : /\b(goal|trying|learn|learning|want to|plan to|aim)\b/.test(lower)
            ? 'goals'
            : 'context';
    sections[key].push(line);
  }
  return sections;
}

function safePreferences(preferenceRows = []) {
  return Object.fromEntries(
    preferenceRows
      .filter(row => SAFE_PREFERENCE_KEYS.has(String(row?.key || '').toLowerCase()))
      .map(row => [String(row.key), normalizeText(row.value)])
      .filter(([, value]) => value)
  );
}

function safeGoals(taskRows = []) {
  return taskRows.slice(0, 20).map(task => ({
    id: task.id,
    goal: normalizeText(task.goal).slice(0, 240),
    status: task.status || 'pending',
    autonomy: task.autonomy || 'Balanced',
    guardMode: task.metadata?.guardMode === true,
    currentStep: Number.isFinite(task.current_step) ? task.current_step : 0,
    updatedAt: task.updated_at || task.created_at || null
  })).filter(task => task.id && task.goal);
}

function buildAgentContext({
  memories = [],
  preferences = [],
  tasks = [],
  connectors = [],
  generatedAt = new Date().toISOString()
} = {}) {
  const profileRow = memories.find(row => row?.source === 'manual_profile');
  const learned = memories
    .filter(row => row?.source !== 'manual_profile')
    .map(row => normalizeText(row?.content))
    .filter(Boolean)
    .slice(0, 24);
  const profileText = String(profileRow?.content || '').trim();

  return {
    agent: DEFAULT_AGENT_IDENTITY,
    profile: {
      text: profileText,
      sections: profileSections(profileText)
    },
    preferences: safePreferences(preferences),
    memories: learned,
    goals: safeGoals(tasks),
    connectedApps: connectors
      .map(row => String(row?.connector_id || '').trim())
      .filter(Boolean)
      .sort(),
    generatedAt
  };
}

async function loadAgentContext(supabase, userId) {
  const [memories, preferences, tasks, connectors] = await Promise.all([
    supabase.from('memories')
      .select('content, source, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('preferences')
      .select('key, value')
      .eq('user_id', userId),
    supabase.from('agent_tasks')
      .select('id, goal, status, autonomy, current_step, metadata, created_at, updated_at')
      .eq('user_id', userId)
      .neq('status', 'recipe')
      .order('updated_at', { ascending: false })
      .limit(20),
    supabase.from('connectors')
      .select('connector_id')
      .eq('user_id', userId)
      .eq('enabled', true)
  ]);

  return buildAgentContext({
    memories: memories.data || [],
    preferences: preferences.data || [],
    tasks: tasks.data || [],
    connectors: connectors.data || []
  });
}

module.exports = {
  DEFAULT_AGENT_IDENTITY,
  buildAgentContext,
  loadAgentContext,
  profileSections,
  safeGoals,
  safePreferences
};
