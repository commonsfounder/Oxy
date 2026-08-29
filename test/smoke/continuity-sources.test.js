const assert = require('node:assert/strict');
const test = require('node:test');
const { zipSync, strToU8 } = require('fflate');

const {
  normaliseContinuityPayload,
  previewContinuity,
  importContinuity,
  filesFromZipBase64
} = require('../../api/services/agent-continuity');
const { readExportBundle, scheduleToMinutes } = require('../../api/services/continuity-sources');

function zipOf(files) {
  const entries = {};
  for (const [name, value] of Object.entries(files)) entries[name] = strToU8(JSON.stringify(value));
  return Buffer.from(zipSync(entries)).toString('base64');
}

// A ChatGPT export: conversations in a tree-shaped file of their own, and the profile
// material in SEPARATE files. Reading only conversations.json is what silently dropped the
// instructions and memory before.
const CHATGPT_EXPORT = {
  'conversations.json': [{
    title: 'Adam planning',
    create_time: 1,
    mapping: {
      a: { message: { author: { role: 'user' }, content: { parts: ['I am building Adam and I prefer direct answers.'] }, create_time: 1 } },
      b: { message: { author: { role: 'assistant' }, content: { parts: ['Understood.'] }, create_time: 2 } }
    }
  }],
  'user.json': { custom_instructions: { about_user_message: 'I live in Birmingham and work in fintech.' } },
  'memory.json': { memories: [{ content: 'Allergic to shellfish' }, { content: 'Partner is called Sam' }] },
  'chat.html': { ignored: true }
};

test('a real ChatGPT export ZIP yields conversations AND the profile material', () => {
  const result = normaliseContinuityPayload({ zipBase64: zipOf(CHATGPT_EXPORT) });

  assert.equal(result.source, 'chatgpt', 'source is detected from layout, not the client label');
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].messages.length, 2);
  assert.ok(
    result.instructions.some(text => /Birmingham/.test(text)),
    'custom instructions live in a separate file and must still be picked up'
  );
  assert.deepEqual(result.memories, ['Allergic to shellfish', 'Partner is called Sam']);
});

test('layout beats the client-declared source', () => {
  const result = normaliseContinuityPayload({ source: 'gemini', zipBase64: zipOf(CHATGPT_EXPORT) });
  assert.equal(result.source, 'chatgpt');
});

test('conversations.json alone imports, and reports honestly what is missing', () => {
  const result = normaliseContinuityPayload({
    source: 'chatgpt',
    files: { 'conversations.json': CHATGPT_EXPORT['conversations.json'] }
  });
  assert.equal(result.conversations.length, 1);
  assert.equal(result.memories.length, 0);
  assert.equal(result.coverage.memories.found, false, 'a partial export must not look complete');
});

test('a Claude export is detected by its own message shape', () => {
  const result = normaliseContinuityPayload({
    zipBase64: zipOf({
      'conversations.json': [{
        uuid: 'c-1',
        name: 'Architecture chat',
        chat_messages: [
          { sender: 'human', text: 'I work at a fintech startup.' },
          { sender: 'assistant', text: 'Noted.' }
        ]
      }]
    })
  });
  assert.equal(result.source, 'claude');
  assert.equal(result.conversations[0].messages.length, 2);
  assert.equal(result.conversations[0].messages[0].role, 'user');
});

test('non-JSON archive members are ignored rather than double-imported', () => {
  const files = filesFromZipBase64(zipOf(CHATGPT_EXPORT));
  assert.ok(files['conversations.json']);
  assert.ok(!Object.keys(files).some(name => name.endsWith('.html')));
});

test('an archive with no usable JSON fails with a readable message', () => {
  assert.throws(
    () => filesFromZipBase64(Buffer.from(zipSync({ 'readme.txt': strToU8('hello') })).toString('base64')),
    /no readable JSON export files/
  );
});

/* ── Workflows ───────────────────────────────────────────────────────────── */

const ZAPIER_EXPORT = {
  'zaps.json': {
    zaps: [
      {
        id: 'zap-1',
        title: 'Daily standup reminder',
        state: 'on',
        nodes: [
          { app: 'Schedule', action: 'Every Day', params: {} },
          { app: 'Slack', action: 'Send Channel Message' }
        ]
      },
      {
        id: 'zap-2',
        title: 'New lead to spreadsheet',
        state: 'on',
        nodes: [
          { app: 'Typeform', action: 'New Entry' },
          { app: 'Google Sheets', action: 'Create Row' }
        ]
      }
    ]
  }
};

test('scheduled Zaps get an interval and event Zaps explicitly do not', () => {
  const result = normaliseContinuityPayload({ zipBase64: zipOf(ZAPIER_EXPORT) });
  assert.equal(result.source, 'zapier');
  assert.equal(result.workflows.length, 2);

  const [daily, lead] = result.workflows;
  assert.equal(daily.triggerKind, 'schedule');
  assert.equal(daily.intervalMinutes, 60 * 24);
  assert.match(daily.prompt, /Slack: Send Channel Message/);

  assert.equal(lead.triggerKind, 'event');
  assert.equal(lead.intervalMinutes, null, 'an event trigger must not become a timer');
  assert.match(lead.prompt, /ran on an event in the source tool/);
});

test('schedule phrasing maps to a cadence', () => {
  assert.equal(scheduleToMinutes({ app: 'Schedule', action: 'Every Hour' }), 60);
  assert.equal(scheduleToMinutes({ app: 'Schedule', action: 'Every Week' }), 60 * 24 * 7);
  assert.equal(scheduleToMinutes({ app: 'Schedule', action: 'Every Day', params: { interval_minutes: 30 } }), 30);
  assert.equal(scheduleToMinutes({ app: 'Typeform', action: 'New Entry' }), null);
});

test('imported automations are written disabled, keyed for re-import', async () => {
  const writes = [];
  const supabase = {
    from(table) {
      const chain = {
        select: () => chain, eq: () => chain, order: () => chain, in: () => chain,
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: { id: 'ws-1' }, error: null }),
        single: () => Promise.resolve({ data: { id: 'import-1' }, error: null }),
        then: (resolve) => Promise.resolve({ data: [], error: null }).then(resolve),
        insert: () => chain,
        update: () => chain,
        upsert: (rows) => { if (table === 'routines') writes.push(...rows); return chain; }
      };
      return chain;
    }
  };

  const result = await importContinuity(supabase, 'user-1', { zipBase64: zipOf(ZAPIER_EXPORT) });

  assert.equal(result.imported.workflows, 2);
  assert.equal(writes.length, 2);
  assert.ok(writes.every(row => row.enabled === false), 'an import must never arrive switched on');
  assert.equal(writes[0].source, 'zapier');
  assert.deepEqual(writes.map(r => r.external_id), ['zap-1', 'zap-2']);
  assert.equal(writes[0].interval_minutes, 60 * 24);
  assert.equal(writes[1].interval_minutes, null);
  assert.equal(writes[0].metadata.activeAtSource, true, 'still live at source — the user must retire it');
});

/* ── Preview ─────────────────────────────────────────────────────────────── */

test('preview reports counts and coverage without writing anything', () => {
  const preview = previewContinuity({ zipBase64: zipOf(CHATGPT_EXPORT) });
  assert.equal(preview.source, 'chatgpt');
  assert.equal(preview.counts.conversations, 1);
  assert.equal(preview.counts.messages, 2);
  assert.equal(preview.counts.memories, 2);
  assert.equal(preview.coverage.instructions.found, true);
});

test('preview lists each automation and how it would run', () => {
  const preview = previewContinuity({ zipBase64: zipOf(ZAPIER_EXPORT) });
  assert.equal(preview.counts.scheduledWorkflows, 1);
  assert.equal(preview.counts.eventWorkflows, 1);
  assert.equal(preview.workflows[0].name, 'Daily standup reminder');
  assert.equal(preview.workflows[1].triggerKind, 'event');
});

test('bundle detection falls back to generic for a hand-shaped payload', () => {
  const bundle = readExportBundle({ '_inline.json': { conversations: [], instructions: 'be brief' } }, 'generic');
  assert.equal(bundle.source, 'generic');
  assert.deepEqual(bundle.instructions, ['be brief']);
});
