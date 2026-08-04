const assert = require('node:assert/strict');
const test = require('node:test');

const {
  callToolsBrain,
  generateBrain,
  streamBrain,
  webSearchBrain
} = require('../../api/services/brain-provider');

const KEYS = [
  'OPENAI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OXY_LOCAL_MODEL_BASE_URL', 'OXY_GEMINI_MODEL', 'OXY_BRAIN_PROVIDER'
];

// Captures the first outbound request instead of making it, so a provider's *destination*
// is assertable without a live key. Every dispatcher must reach the vendor it was asked
// for: a silent hop to whichever client sits last in the chain is the bug these guard.
function withCapturedFetch(run, { env = {} } = {}) {
  const savedFetch = global.fetch;
  const savedEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const seen = {};
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, {
    OPENAI_API_KEY: 'k', GROQ_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k',
    OXY_LOCAL_MODEL_BASE_URL: 'http://localhost:11434/v1',
    ...env
  });
  global.fetch = async (url, options) => {
    seen.url = String(url);
    seen.body = JSON.parse(options?.body || '{}');
    throw new Error('captured');
  };
  return Promise.resolve()
    .then(() => run(seen))
    .finally(() => {
      global.fetch = savedFetch;
      for (const k of KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });
}

const ARGS = { model: 'route-model', contents: [{ role: 'user', parts: [{ text: 'hi' }] }], config: {} };

const HOSTS = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  groq: 'api.groq.com',
  local: 'localhost:11434',
  gemini: 'generativelanguage.googleapis.com'
};

test('every provider reaches its own vendor on the tool-calling path', async () => {
  for (const [provider, host] of Object.entries(HOSTS)) {
    await withCapturedFetch(async (seen) => {
      await callToolsBrain({ provider, ...ARGS }).catch(() => {});
      assert.ok(seen.url?.includes(host), `${provider} tool call went to ${seen.url}, expected ${host}`);
    });
  }
});

test('every provider reaches its own vendor on the non-streaming path', async () => {
  for (const [provider, host] of Object.entries(HOSTS)) {
    await withCapturedFetch(async (seen) => {
      await generateBrain({ provider, ...ARGS }).catch(() => {});
      assert.ok(seen.url?.includes(host), `${provider} generate went to ${seen.url}, expected ${host}`);
    });
  }
});

test('an unknown provider throws instead of falling through to Gemini', async () => {
  await withCapturedFetch(async () => {
    await assert.rejects(() => callToolsBrain({ provider: 'typo', ...ARGS }), /Unknown brain provider: typo/);
    await assert.rejects(() => generateBrain({ provider: 'typo', ...ARGS }), /Unknown brain provider: typo/);
    assert.throws(() => streamBrain({ provider: 'typo', ...ARGS }), /Unknown brain provider: typo/);
  });
});

test('OpenAI-compatible providers do not inherit the reasoning-tier request shape', async () => {
  const config = { tools: [{ functionDeclarations: [{ name: 'find_place', description: 'x', parameters: { type: 'OBJECT', properties: {} } }] }] };

  await withCapturedFetch(async (seen) => {
    await callToolsBrain({ provider: 'groq', ...ARGS, config }).catch(() => {});
    assert.equal(seen.body.tools?.[0]?.function?.name, 'find_place', 'Groq must receive real tool declarations');
    assert.ok(seen.body.max_tokens > 0, 'Groq takes max_tokens, not max_completion_tokens');
    assert.equal(seen.body.max_completion_tokens, undefined);
    assert.equal(seen.body.reasoning_effort, undefined, 'Groq rejects reasoning_effort');
  });

  await withCapturedFetch(async (seen) => {
    await callToolsBrain({ provider: 'openai', ...ARGS, config }).catch(() => {});
    assert.equal(seen.body.reasoning_effort, 'none', 'OpenAI tool turns still pin reasoning_effort to none');
    assert.ok(seen.body.max_completion_tokens > 0);
  });
});

test('groq and local resolve their own default model when none is supplied', async () => {
  await withCapturedFetch(async (seen) => {
    await generateBrain({ provider: 'groq', ...ARGS, model: undefined }).catch(() => {});
    assert.equal(seen.body.model, 'llama-3.3-70b-versatile');
  });
  await withCapturedFetch(async (seen) => {
    await generateBrain({ provider: 'local', ...ARGS, model: undefined }).catch(() => {});
    assert.equal(seen.body.model, 'llama3.2');
  });
});

test('local fails with a named error when its base URL is unset', async () => {
  await withCapturedFetch(async () => {
    await assert.rejects(
      () => generateBrain({ provider: 'local', ...ARGS }),
      /OXY_LOCAL_MODEL_BASE_URL is not set/
    );
  }, { env: { OXY_LOCAL_MODEL_BASE_URL: '' } });
});

test('borrowed grounding sends a Gemini model id, never the routed provider\'s', async () => {
  await withCapturedFetch(async (seen) => {
    await webSearchBrain({ provider: 'anthropic', model: 'claude-sonnet-5', prompt: 'weather' }).catch(() => {});
    assert.ok(seen.url?.includes('generativelanguage.googleapis.com'));
    assert.ok(
      seen.url?.includes('gemini-2.5-flash'),
      `grounding forwarded a non-Gemini model id: ${seen.url}`
    );
    assert.ok(!seen.url?.includes('claude'));
  });
});

test('grounding returns empty rather than calling Gemini with no key', async () => {
  await withCapturedFetch(async (seen) => {
    const text = await webSearchBrain({ provider: 'anthropic', model: 'claude-sonnet-5', prompt: 'weather' });
    assert.equal(text, '');
    assert.equal(seen.url, undefined, 'no request should be attempted without a Gemini key');
  }, { env: { GEMINI_API_KEY: '', GOOGLE_API_KEY: '' } });
});
