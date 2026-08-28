'use strict';
// Optional domain guidance.
//
// A playbook makes Adam BETTER at a kind of task. It must never be what makes the task
// possible. The architectural test: delete every playbook here and the agent can still open a
// page, read it, click, type, upload, verify and ask for approval — it just does it with less
// judgement about what usually works.
//
// That is the whole difference between this file and the shopping subsystem it replaced.
// Guidance used to be welded into the browser loop's decision prompt, which meant the loop
// could not exist without it, and every new domain would have needed its own loop.
//
// Adding a domain here is adding TEXT, not architecture. Nothing branches on `id`.

/** @typedef {{ id: string, title: string, appliesTo: RegExp, excludes?: RegExp, guidance: string }} Playbook */

/** @type {Playbook[]} */
const PLAYBOOKS = [
  {
    id: 'purchasing',
    title: 'Buying something',
    appliesTo: /\b(?:buy|purchase|order(?:\s+me)?|checkout|check\s+out|takeaway|takeout|deliver(?:y|ed))\b|\badd(?:\s+\w+){0,6}?\s+to\s+(?:my\s+)?(?:basket|cart|bag|trolley)\b/i,
    // Managing something that already exists is not buying something new.
    // Managing something that already exists is not buying something new. "Change my
    // delivery address on my order" contains "delivery" and "order" and is neither.
    excludes: /\b(?:cancel|unsubscribe|refund|return|dispute|renew|track|amend|update|change|edit|manage)\b/i,
    guidance: `Work the site the same way you would any other: open it, look, take one step,
look again. A purchase is roughly — find the item, open it, set any required options, add it,
go to the basket, start checkout, get past the account wall, fill in what you already know,
choose delivery, then hand over to the transaction capabilities for the money.
Commit to a reasonable match rather than researching indefinitely: an acceptable item in the
basket beats a perfect one that never gets added. Treat the model, generation, capacity or
size named in the goal as a REQUIREMENT, never substituting a different tier. If a required
option (size, colour) is unselected, the add button will appear to do nothing — select it
first, which the page-did-not-change signal will tell you. Check quantity, seller and the
total delivered cost, not just the headline price. Prefer the free or cheapest delivery
option unless the goal asked for speed — read the options and pick, do not accept whichever
is pre-selected. Watch for anything that silently adds a subscription, warranty or
membership. The order is not placed until the page itself says so: verify, do not assume.`,
  },
  {
    id: 'paying',
    title: 'Paying for something',
    appliesTo: /\b(?:pay|paying|payment|checkout|check\s+out|deposit|fee|fare|top\s?up|renew|fine|bill)\b|\b(?:buy|purchase|order(?:\s+me)?)\b/i,
    guidance: `Never press a control that charges money yourself. When the page is asking for
payment, call transaction_prepare: it reads the amount with a parser and finds the control,
without pressing it. Tell the person the amount it reported — never one you inferred — and
only after they agree, call transaction_authorize. If their bank asks them to approve it in
their banking app, that is a pause, not a failure: say so plainly and use transaction_status
when they confirm. Afterwards, check the page actually says the payment succeeded.`,
  },
  {
    id: 'account-admin',
    title: 'Changing or cancelling something that already exists',
    appliesTo: /\b(?:cancel|unsubscribe|close|deactivate|delete|downgrade|upgrade|renew|update|change|amend|edit|manage)\b.{0,40}\b(?:account|subscription|membership|plan|policy|address|details|payment\s+method|direct\s+debit|booking|order)\b/i,
    guidance: `The control for this is usually behind an account or settings area, not on the
marketing page — sign-in is often required before it appears. Retention flows are common:
expect an offer, a survey, or a "are you sure" step between the button and the actual change,
and keep going through them rather than treating the first click as done. Never accept a
downgrade, pause or discount as a substitute for what was asked for. Finish by reading the page
back: the change has happened only when the page states the new state or a confirmation is
shown.`,
  },
  {
    id: 'forms',
    title: 'Filling in a form or application',
    appliesTo: /\b(?:apply|application|form|claim|register|enrol|enroll|submit|renew)\b/i,
    guidance: `Fill what is already known before asking the person anything — stored identity
details cover most contact and address fields. Ask ONLY for the genuinely unknown, and ask for
all of it at once rather than one field per turn. Never invent a value for a field you cannot
source, and never guess at anything with legal weight (a national insurance number, a date of
birth, a declaration). Where a file is required, upload one of the person's own stored
documents by id; if the right document is not there, say what is missing instead of uploading
something that merely sounds close. Read the page back after submitting: a reference number or
an acknowledgement is the evidence, not the fact that the button was pressed.`,
  },
];

/**
 * Guidance for a goal. Multiple playbooks can apply; all matching text is returned.
 * Returns '' when nothing matches, which is a normal, fully-functional case.
 * @param {string} goal
 * @returns {string}
 */
function playbookGuidanceFor(goal) {
  const text = String(goal || '');
  if (!text.trim()) return '';
  const matched = PLAYBOOKS.filter(p => p.appliesTo.test(text) && !(p.excludes && p.excludes.test(text)));
  if (!matched.length) return '';
  return matched
    .map(p => `${p.title.toUpperCase()}\n${p.guidance.replace(/\s*\n\s*/g, ' ').trim()}`)
    .join('\n\n');
}

/** Ids that apply to a goal. Diagnostics and tests only — nothing executes off this. */
function playbooksFor(goal) {
  const text = String(goal || '');
  return PLAYBOOKS.filter(p => p.appliesTo.test(text) && !(p.excludes && p.excludes.test(text))).map(p => p.id);
}

module.exports = { PLAYBOOKS, playbookGuidanceFor, playbooksFor };
