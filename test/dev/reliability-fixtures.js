'use strict';
// The reliability basket — the denominator for "X% of sites work": a spread of UK sites across
// categories that stress different parts of the loop (search, hydration, consent, bot-walling).
//
// Goals are safe and deterministically scorable. `expect: 'answer'` is a price lookup needing no
// user data, so a failure is a loop failure. `expect: 'cart'` builds a basket up to the payment
// guardrail, which stops at the pay button — no real payment is ever reached — and carries a size
// in the goal so the loop never has to ask.
//
// `tags` slice the scorecard; `known-botwall` separates "the loop can't do it" from "this IP
// can't reach it".

module.exports = [
  // --- Department / fashion ---
  // Full order path: search → product → size → add to basket → basket → checkout (payment guardrail stops here).
  // Size is explicit in the goal so the loop never has to ask. `reauth` counts as a ceiling (login wall),
  // not a loop failure — the loop did its job.
  { site: 'johnlewis.com',      url: 'https://www.johnlewis.com',      goal: 'order a men\'s plain crew-neck sweatshirt in size medium, add to basket and go to checkout', expect: 'cart', tags: ['fashion', 'has-fastpath', 'has-recipe'] },
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

  // --- Read-only tasks on a further 31 distinct sites ---
  // These finish when the agent has retrieved the requested fact. Together with the
  // order-path cases above this makes a 50-site cross-domain capability benchmark:
  // no merchant receives a real order, sign-up, payment, or personal information.
  { site: 'amazon.co.uk',       url: 'https://www.amazon.co.uk',       goal: 'find the Dyson V15 cordless vacuum and report its current price and review count', expect: 'answer', tags: ['lookup', 'marketplace'] },
  { site: 'harveynichols.com',  url: 'https://www.harveynichols.com',  goal: 'find Balenciaga trainers and report the displayed price', expect: 'answer', tags: ['lookup', 'luxury'] },
  { site: 'boots.com',          url: 'https://www.boots.com',          goal: 'find Olay Regenerist serum and report its price and customer rating', expect: 'answer', tags: ['lookup', 'health-beauty'] },
  { site: 'spacenk.com',        url: 'https://www.spacenk.com',        goal: 'find MAC Fix+ setting spray and report the displayed price', expect: 'answer', tags: ['lookup', 'health-beauty'] },
  { site: 'apple.com',          url: 'https://www.apple.com/uk',       goal: 'find the current UK starting price of the iPhone 16', expect: 'answer', tags: ['lookup', 'manufacturer'] },
  { site: 'samsung.com',        url: 'https://www.samsung.com/uk',     goal: 'find the Galaxy S25 Ultra and report its price and storage options', expect: 'answer', tags: ['lookup', 'manufacturer'] },
  { site: 'scan.co.uk',         url: 'https://www.scan.co.uk',         goal: 'find an RTX 5090 graphics card and report the cheapest in-stock price', expect: 'answer', tags: ['lookup', 'specialist-retail'] },
  { site: 'box.co.uk',          url: 'https://www.box.co.uk',          goal: 'find the DJI Mini 4 Pro drone and report the displayed price', expect: 'answer', tags: ['lookup', 'specialist-retail'] },
  { site: 'overclockers.co.uk', url: 'https://www.overclockers.co.uk', goal: 'find an AMD Ryzen 9 9950X processor and report the displayed price', expect: 'answer', tags: ['lookup', 'specialist-retail'] },
  { site: 'cclcomputers.com',   url: 'https://www.cclcomputers.com',   goal: 'find a Dell XPS 15 laptop and report the displayed price', expect: 'answer', tags: ['lookup', 'specialist-retail'] },
  { site: 'uniqlo.com',         url: 'https://www.uniqlo.com/uk',      goal: 'find HEATTECH thermal leggings and report the displayed price', expect: 'answer', tags: ['lookup', 'fashion'] },
  { site: 'dunelm.com',         url: 'https://www.dunelm.com',         goal: 'find a grey corner sofa and report its price and dimensions', expect: 'answer', tags: ['lookup', 'home'] },
  { site: 'wayfair.co.uk',      url: 'https://www.wayfair.co.uk',      goal: 'find a standing desk and report the available price range', expect: 'answer', tags: ['lookup', 'home'] },
  { site: 'waterstones.com',    url: 'https://www.waterstones.com',    goal: 'find Lessons in Chemistry by Bonnie Garmus and report the paperback price', expect: 'answer', tags: ['lookup', 'books'] },
  { site: 'foyles.co.uk',       url: 'https://www.foyles.co.uk',       goal: 'find Educated by Tara Westover and report the paperback price', expect: 'answer', tags: ['lookup', 'books'] },
  { site: 'iceland.co.uk',      url: 'https://www.iceland.co.uk',      goal: 'find frozen fish fillets and report the displayed price', expect: 'answer', tags: ['lookup', 'grocery'] },
  { site: 'ocado.com',          url: 'https://www.ocado.com',          goal: 'find organic free-range eggs and report the displayed price', expect: 'answer', tags: ['lookup', 'grocery'] },
  { site: 'jdsports.co.uk',     url: 'https://www.jdsports.co.uk',     goal: 'find Adidas Ultraboost running shoes and report the displayed price', expect: 'answer', tags: ['lookup', 'sports'] },
  { site: 'decathlon.co.uk',    url: 'https://www.decathlon.co.uk',    goal: 'find a yoga mat and report the displayed price', expect: 'answer', tags: ['lookup', 'sports'] },
  { site: 'sportsdirect.com',   url: 'https://www.sportsdirect.com',   goal: 'find football boots and report the cheapest displayed price', expect: 'answer', tags: ['lookup', 'sports'] },
  { site: 'gooutdoors.co.uk',   url: 'https://www.gooutdoors.co.uk',   goal: 'find a two-person tent and report the displayed price', expect: 'answer', tags: ['lookup', 'outdoor'] },
  { site: 'sephora.co.uk',      url: 'https://www.sephora.co.uk',      goal: 'find Charlotte Tilbury Red Carpet Red lipstick and report the price', expect: 'answer', tags: ['lookup', 'health-beauty'] },
  { site: 'cultbeauty.co.uk',   url: 'https://www.cultbeauty.co.uk',   goal: 'find La Roche-Posay thermal spring water and report the displayed price', expect: 'answer', tags: ['lookup', 'health-beauty'] },
  { site: 'beautylish.com',     url: 'https://www.beautylish.com',     goal: 'find the Dyson Supersonic hair dryer and report the displayed price', expect: 'answer', tags: ['lookup', 'health-beauty'] },
  { site: 'ikea.com',           url: 'https://www.ikea.com/gb/en',     goal: 'find the KALLAX shelving unit and report its current price', expect: 'answer', tags: ['lookup', 'home'] },
  { site: 'diy.com',            url: 'https://www.diy.com',            goal: 'find Dulux white matt emulsion paint and report the displayed price', expect: 'answer', tags: ['lookup', 'diy'] },
  { site: 'petsathome.com',     url: 'https://www.petsathome.com',     goal: 'find dry cat food and report the cheapest displayed price', expect: 'answer', tags: ['lookup', 'pet'] },
  { site: 'thomann.co.uk',      url: 'https://www.thomann.co.uk',      goal: 'find a Yamaha acoustic guitar and report the displayed price', expect: 'answer', tags: ['lookup', 'music'] },
  { site: 'thetrainline.com',   url: 'https://www.thetrainline.com',   goal: 'find the first train from Birmingham Moor Street to London Marylebone tomorrow morning and report its departure time', expect: 'answer', tags: ['lookup', 'travel'] },
  { site: 'nationalrail.co.uk', url: 'https://www.nationalrail.co.uk', goal: 'find the next train from Birmingham Moor Street to London Marylebone and report its departure time', expect: 'answer', tags: ['lookup', 'travel'] },
  { site: 'booking.com',        url: 'https://www.booking.com',        goal: 'find the top-rated hotel in Birmingham city centre and report its rating', expect: 'answer', tags: ['lookup', 'travel'] },
];
