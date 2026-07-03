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
  // --- Department / fashion ---
  // Full order path: search → product → size → add to basket → basket → checkout (payment guardrail stops here).
  // Size is explicit in the goal so the loop never has to ask. `reauth` counts as a ceiling (login wall),
  // not a loop failure — the loop did its job.
  { site: 'johnlewis.com',      url: 'https://www.johnlewis.com',      goal: 'order adidas joggers in size medium, add to basket and go to checkout', expect: 'cart', tags: ['fashion', 'has-fastpath', 'has-recipe'] },
  { site: 'selfridges.com',     url: 'https://www.selfridges.com',     goal: 'order a leather belt in size medium, add to bag and go to checkout', expect: 'cart', tags: ['fashion', 'has-fastpath'] },
  { site: 'marksandspencer.com',url: 'https://www.marksandspencer.com',goal: 'order a cotton t-shirt in size medium, add to basket and go to checkout', expect: 'cart', tags: ['fashion', 'has-fastpath'] },
  { site: 'asos.com',           url: 'https://www.asos.com',           goal: 'order black skinny jeans in size 32 waist, add to bag and go to checkout', expect: 'cart', tags: ['fashion'] },
  { site: 'next.co.uk',         url: 'https://www.next.co.uk',         goal: 'order a wool jumper in size medium, add to bag and go to checkout', expect: 'cart', tags: ['fashion', 'known-botwall'] },
  { site: 'zara.com',           url: 'https://www.zara.com/uk',        goal: 'order a denim jacket in size medium, add to cart and go to checkout', expect: 'cart', tags: ['fashion', 'known-botwall'] },
  { site: 'hm.com',             url: 'https://www2.hm.com/en_gb',      goal: 'order a hoodie in size medium, add to cart and go to checkout', expect: 'cart', tags: ['fashion', 'known-botwall'] },

  // --- Grocery: no size needed, just add to basket and go to checkout ---
  { site: 'sainsburys.co.uk',   url: 'https://www.sainsburys.co.uk',   goal: 'add semi skimmed milk to basket and go to checkout', expect: 'cart', tags: ['grocery', 'has-fastpath'] },
  { site: 'waitrose.com',       url: 'https://www.waitrose.com',       goal: 'add olive oil to basket and go to checkout', expect: 'cart', tags: ['grocery', 'has-fastpath'] },
  { site: 'tesco.com',          url: 'https://www.tesco.com',          goal: 'add cheddar cheese to basket and go to checkout', expect: 'cart', tags: ['grocery', 'known-botwall'] },

  // --- Electronics / DIY / sportswear ---
  { site: 'currys.co.uk',       url: 'https://www.currys.co.uk',       goal: 'add a wireless mouse to basket and go to checkout', expect: 'cart', tags: ['electronics', 'has-fastpath'] },
  { site: 'screwfix.com',       url: 'https://www.screwfix.com',       goal: 'add a cordless drill to basket and go to checkout', expect: 'cart', tags: ['diy', 'has-fastpath'] },
  // Pinned PDP: search-first can land on intermittently undeliverable SKUs (~30s vision spin).
  { site: 'wickes.co.uk',       url: 'https://www.wickes.co.uk/Crown-Matt-Emulsion-Paint---Pure-Brilliant-White---10L/p/166844', goal: 'add white paint to basket and go to checkout', expect: 'cart', tags: ['diy', 'has-fastpath', 'has-recipe'] },
  { site: 'toolstation.com',    url: 'https://www.toolstation.com',    goal: 'add a tape measure to basket for collection near EC1A 1BB and go to checkout', expect: 'cart', tags: ['diy', 'has-fastpath'] },
  { site: 'nike.com',           url: 'https://www.nike.com/gb',        goal: 'order mens running shoes in size UK 10, add to bag and go to checkout', expect: 'cart', tags: ['sportswear', 'has-fastpath'] },
  { site: 'argos.co.uk',        url: 'https://www.argos.co.uk',        goal: 'add a kettle to basket and go to checkout', expect: 'cart', tags: ['electronics', 'known-botwall'] },

  // --- Delivery: the address-first flow + the cart-commit weak spot ---
  { site: 'ubereats.com',       url: 'https://www.ubereats.com',       goal: 'order a pizza from a pizza place near EC1A 1BB London', expect: 'cart', tags: ['delivery'] },
  { site: 'deliveroo.co.uk',    url: 'https://deliveroo.co.uk',        goal: 'order a burger near EC1A 1BB London', expect: 'cart', tags: ['delivery', 'known-botwall'] },
  { site: 'just-eat.co.uk',     url: 'https://www.just-eat.co.uk',     goal: 'order a curry near EC1A 1BB London', expect: 'cart', tags: ['delivery', 'known-botwall'] },
];
