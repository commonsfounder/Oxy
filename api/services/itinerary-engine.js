// Gemini-powered day-by-day itinerary generation + natural language modification.
// Uses the FAST_MODEL for generation; does NOT hallucinate bookings or prices —
// all cost estimates are labelled approximate, and live results are passed in.

const ITINERARY_SYSTEM = `You are an expert travel planner. Generate a detailed, realistic day-by-day itinerary in JSON.

Rules:
- Organise days geographically to minimise unnecessary travel between areas
- Provide a WHY for each key recommendation (e.g. "Chosen because it is within walking distance of your hotel and has strong reviews for couples")
- Balance activities across morning / afternoon / evening; respect travel pace preference
- Include estimated costs per activity where known; use null when unknown
- Do not invent specific prices, availability, or booking confirmations — mark estimates as approximate
- Respect all dietary requirements and accessibility needs
- Suggest alternatives for each day's highlight activity

Output ONLY valid JSON matching this schema:
{
  "title": "string",
  "destination": "string",
  "startDate": "YYYY-MM-DD or null",
  "endDate": "YYYY-MM-DD or null",
  "totalDays": number,
  "estimatedBudget": { "total": number, "currency": "GBP", "breakdown": { "accommodation": number, "activities": number, "food": number, "transport": number }, "note": "approximate" },
  "days": [
    {
      "day": 1,
      "date": "YYYY-MM-DD or null",
      "area": "neighbourhood/district focus for the day",
      "theme": "e.g. History & Culture",
      "morning": { "activity": "string", "duration": "e.g. 2 hours", "estimatedCost": number | null, "why": "string" },
      "afternoon": { "activity": "string", "duration": "string", "estimatedCost": number | null, "why": "string" },
      "evening": { "activity": "string", "duration": "string", "estimatedCost": number | null, "why": "string" },
      "meals": { "breakfast": "string", "lunch": "string", "dinner": "string" },
      "travelTips": "string",
      "alternatives": ["alternative for main activity"]
    }
  ],
  "generalTips": ["tip1", "tip2"],
  "packingHighlights": ["item1", "item2"]
}`;

const MODIFY_SYSTEM = `You are an expert travel planner modifying an existing itinerary based on user feedback.

Rules:
- Apply the specific change requested; preserve everything else
- Provide a brief explanation of what changed and why
- Do not regenerate the whole trip unless the change requires it
- Maintain geographical efficiency after the change

Output ONLY valid JSON in this exact structure:
{
  "changed": true,
  "summary": "one sentence describing what changed",
  "days": [...] // modified days array, same schema as itinerary days
}`;

function buildItineraryPrompt(requirements, searchResults, userProfile) {
  const sections = [
    `Trip requirements: ${JSON.stringify(requirements)}`,
    userProfile ? `User travel profile: ${JSON.stringify(userProfile)}` : '',
    searchResults?.hotels?.length
      ? `Available hotels (pre-ranked): ${JSON.stringify(searchResults.hotels.slice(0, 3))}` : '',
    searchResults?.activities?.length
      ? `Available activities: ${JSON.stringify(searchResults.activities.slice(0, 8))}` : '',
    searchResults?.flights?.length
      ? `Flight options: ${JSON.stringify(searchResults.flights.slice(0, 2))}` : ''
  ].filter(Boolean).join('\n\n');

  return `Generate a complete itinerary.\n\n${sections}`;
}

function buildModifyPrompt(itinerary, instruction, requirements) {
  return [
    `Existing itinerary: ${JSON.stringify(itinerary)}`,
    `Original requirements: ${JSON.stringify(requirements || {})}`,
    `User modification request: "${instruction}"`,
    'Apply the change. Return only the modified days array and a summary of changes.'
  ].join('\n\n');
}

async function generateItinerary(requirements, searchResults = {}, userProfile = null, callModel) {
  if (!callModel) throw new Error('callModel is required for itinerary generation.');
  if (!requirements?.destination) throw new Error('destination is required in requirements.');

  const prompt = buildItineraryPrompt(requirements, searchResults, userProfile);
  const raw = await callModel(ITINERARY_SYSTEM, prompt);
  if (!raw) throw new Error('No response from model.');

  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const itinerary = JSON.parse(clean);

  // Sanity check
  if (!itinerary.days || !Array.isArray(itinerary.days)) {
    throw new Error('Model returned invalid itinerary structure.');
  }

  return itinerary;
}

async function modifyItinerary(existingItinerary, instruction, requirements, callModel) {
  if (!callModel) throw new Error('callModel is required for itinerary modification.');
  if (!instruction) throw new Error('instruction is required.');

  const prompt = buildModifyPrompt(existingItinerary, instruction, requirements);
  const raw = await callModel(MODIFY_SYSTEM, prompt);
  if (!raw) throw new Error('No response from model.');

  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const result = JSON.parse(clean);

  if (!result.days) throw new Error('Model returned invalid modification structure.');

  return {
    ...existingItinerary,
    days: result.days,
    lastModification: {
      instruction,
      summary: result.summary || '',
      modifiedAt: new Date().toISOString()
    }
  };
}

function itineraryToText(itinerary) {
  if (!itinerary?.days?.length) return 'No itinerary generated.';
  const lines = [`**${itinerary.title || itinerary.destination} — ${itinerary.totalDays}-day itinerary**\n`];
  for (const day of itinerary.days) {
    lines.push(`**Day ${day.day}${day.date ? ` (${day.date})` : ''}: ${day.theme || day.area || ''}**`);
    if (day.morning) lines.push(`Morning: ${day.morning.activity}`);
    if (day.afternoon) lines.push(`Afternoon: ${day.afternoon.activity}`);
    if (day.evening) lines.push(`Evening: ${day.evening.activity}`);
    lines.push('');
  }
  if (itinerary.estimatedBudget?.total) {
    lines.push(`Estimated total budget: £${itinerary.estimatedBudget.total} (${itinerary.estimatedBudget.note || 'approximate'})`);
  }
  return lines.join('\n');
}

module.exports = {
  generateItinerary,
  modifyItinerary,
  itineraryToText,
  buildItineraryPrompt,
  buildModifyPrompt
};
