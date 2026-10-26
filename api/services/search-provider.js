'use strict';

// Web search through Exa, when it is switched on. The search returns page highlights; the cheap
// model then writes the answer from them. Off unless OXY_SEARCH_PROVIDER=exa and an Exa key is set,
// so nothing changes until it is chosen. Any failure falls back to the OpenAI search.

const usageMeter = require('./usage-meter');

const EXA_URL = 'https://api.exa.ai/search';

function exaEnabled(env = process.env) {
  return String(env.OXY_SEARCH_PROVIDER || '').toLowerCase() === 'exa' && Boolean(String(env.EXA_API_KEY || '').trim());
}

async function exaSearch(query, { fetchImpl = fetch, env = process.env, numResults = 5 } = {}) {
  const response = await fetchImpl(EXA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.EXA_API_KEY },
    body: JSON.stringify({
      query,
      type: env.OXY_EXA_TYPE || 'auto',
      numResults,
      contents: { highlights: { maxCharacters: 1200 } },
    }),
  });
  if (!response.ok) throw new Error(`Exa ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const json = await response.json();
  const total = Number(json.costDollars?.total);
  usageMeter.recordCost('exa', Number.isFinite(total) ? total : 0.007);
  return (json.results || []).map((item) => ({
    title: String(item.title || '').slice(0, 160),
    url: item.url,
    date: item.publishedDate || null,
    text: (Array.isArray(item.highlights) ? item.highlights.join(' … ') : '').slice(0, 1500),
  })).filter((item) => item.url && item.text);
}

function answerPrompt({ question, today, results }) {
  const sources = results.map((item, index) => `[${index + 1}] ${item.title} (${item.url}${item.date ? `, ${String(item.date).slice(0, 10)}` : ''})\n${item.text}`).join('\n\n');
  return `Today's date is ${today}. Answer concisely for: "${question}". Use only what the sources below say, answer the question that was actually asked, and say so if results look older than today or sources disagree instead of guessing. Mention prices or options only when the question is about buying something. Plain prose, no markdown headings or asterisks. Cite by putting the source's domain in brackets at the end of the sentence it supports, like ([example.com](https://example.com/page)).\n\nSources:\n${sources}`;
}

module.exports = { exaEnabled, exaSearch, answerPrompt };
