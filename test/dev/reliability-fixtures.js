'use strict';
// The reliability basket: a representative spread of UK sites the assistant is actually
// asked to shop on, across categories that stress DIFFERENT parts of the loop (search,
// hydration, consent, bot-walling). This is the denominator for "X% of sites work".
//
// Goals are chosen to be SAFE and DETERMINISTICALLY SCORABLE:
//  - `expect: 'answer'`  → a pure price/info lookup; success is a `done` with a summary.
//    No user data (address/size) needed, so a failure is a LOOP failure, not missing input.
//  - `expect: 'cart'`    → build a basket up to the pay guardrail; success is
//    `ready_for_payment` (or `done`). Needs a size in the goal so the loop never has to ask.
//
// Deliberately NO real payment is ever reached — the payment guardrail stops the loop at
// the pay button, which is exactly the success state for a `cart` case.
//
// `tags`: freeform, for slicing the scorecard (e.g. only `grocery`, only `known-botwall`).
// `known-botwall` marks sites we already expect a datacenter IP to be blocked on, so the
// scorecard can separate "loop can't do it" from "infra (IP) can't reach it".

module.exports = [
  // --- Department / fashion: the proven-ish core + the long tail ---
  { site: 'johnlewis.com',      url: 'https://www.johnlewis.com',      goal: 'find a pair of mens joggers and tell me the exact price shown', expect: 'answer', tags: ['fashion', 'has-fastpath', 'has-recipe'] },
  { site: 'selfridges.com',     url: 'https://www.selfridges.com',     goal: 'find a leather belt and tell me the price', expect: 'answer', tags: ['fashion', 'has-fastpath'] },
  { site: 'marksandspencer.com',url: 'https://www.marksandspencer.com',goal: 'find a cotton t-shirt and tell me the price', expect: 'answer', tags: ['fashion', 'has-fastpath'] },
  { site: 'asos.com',           url: 'https://www.asos.com',           goal: 'find black skinny jeans and tell me the price', expect: 'answer', tags: ['fashion', 'has-fastpath'] },
  { site: 'next.co.uk',         url: 'https://www.next.co.uk',         goal: 'find a wool jumper and tell me the price', expect: 'answer', tags: ['fashion', 'known-botwall'] },
  { site: 'zara.com',           url: 'https://www.zara.com/uk',        goal: 'find a denim jacket and tell me the price', expect: 'answer', tags: ['fashion', 'known-botwall'] },
  { site: 'hm.com',             url: 'https://www2.hm.com/en_gb',      goal: 'find a hoodie and tell me the price', expect: 'answer', tags: ['fashion', 'known-botwall'] },

  // --- Grocery: search shapes differ (path vs query param), heavy consent walls ---
  { site: 'sainsburys.co.uk',   url: 'https://www.sainsburys.co.uk',   goal: 'find semi skimmed milk and tell me the price', expect: 'answer', tags: ['grocery', 'has-fastpath'] },
  { site: 'waitrose.com',       url: 'https://www.waitrose.com',       goal: 'find olive oil and tell me the price', expect: 'answer', tags: ['grocery', 'has-fastpath'] },
  { site: 'tesco.com',          url: 'https://www.tesco.com',          goal: 'find cheddar cheese and tell me the price', expect: 'answer', tags: ['grocery', 'known-botwall'] },

  // --- Electronics / DIY / sportswear ---
  { site: 'currys.co.uk',       url: 'https://www.currys.co.uk',       goal: 'find a wireless mouse and tell me the price', expect: 'answer', tags: ['electronics', 'has-fastpath'] },
  { site: 'screwfix.com',       url: 'https://www.screwfix.com',       goal: 'find a cordless drill and tell me the price', expect: 'answer', tags: ['diy', 'has-fastpath'] },
  { site: 'wickes.co.uk',       url: 'https://www.wickes.co.uk',       goal: 'find white paint and tell me the price', expect: 'answer', tags: ['diy', 'has-fastpath'] },
  { site: 'toolstation.com',    url: 'https://www.toolstation.com',    goal: 'find a tape measure and tell me the price', expect: 'answer', tags: ['diy', 'has-fastpath'] },
  { site: 'nike.com',           url: 'https://www.nike.com/gb',        goal: 'find mens running shoes and tell me the price', expect: 'answer', tags: ['sportswear', 'has-fastpath'] },
  { site: 'argos.co.uk',        url: 'https://www.argos.co.uk',        goal: 'find a kettle and tell me the price', expect: 'answer', tags: ['electronics', 'known-botwall'] },

  // --- Delivery: the address-first flow + the cart-commit weak spot ---
  { site: 'ubereats.com',       url: 'https://www.ubereats.com',       goal: 'order a pizza from a pizza place near EC1A 1BB London', expect: 'cart', tags: ['delivery'] },
  { site: 'deliveroo.co.uk',    url: 'https://deliveroo.co.uk',        goal: 'order a burger near EC1A 1BB London', expect: 'cart', tags: ['delivery', 'known-botwall'] },
  { site: 'just-eat.co.uk',     url: 'https://www.just-eat.co.uk',     goal: 'order a curry near EC1A 1BB London', expect: 'cart', tags: ['delivery', 'known-botwall'] },
];
