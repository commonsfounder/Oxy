'use strict';

const DEFAULTS = { effort: 'medium', guardMode: false };

async function getChatSettings(supabase, userId) {
  try {
    const { data, error } = await supabase.from('chat_settings').select('*').eq('user_id', userId).single();
    if (error || !data) return { ...DEFAULTS };
    return { effort: data.effort, guardMode: data.guard_mode };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

async function saveChatSettings(supabase, userId, { effort, guardMode }) {
  try {
    const { error } = await supabase
      .from('chat_settings')
      .upsert({ user_id: userId, effort, guard_mode: guardMode, updated_at: new Date().toISOString() });
    if (error) return { error };
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { getChatSettings, saveChatSettings };
