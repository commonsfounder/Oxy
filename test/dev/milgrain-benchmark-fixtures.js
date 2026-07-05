'use strict';
// Milgrain browser-task lookup latency basket — info/price goals only (expect: answer).
// Run: node test/dev/milgrain-benchmark.js

module.exports = [
  // E-commerce & Shopping
  { id: 1, category: 'ecommerce', site: 'johnlewis.com', url: 'https://www.johnlewis.com', goal: 'Find Sony WH-CH720N headphones and get the price', expect: 'answer' },
  { id: 2, category: 'ecommerce', site: 'currys.co.uk', url: 'https://www.currys.co.uk', goal: 'Search for iPad Air latest model and availability', expect: 'answer' },
  { id: 3, category: 'ecommerce', site: 'amazon.co.uk', url: 'https://www.amazon.co.uk', goal: 'Look up Dyson V15 cordless vacuum and reviews count', expect: 'answer' },
  { id: 4, category: 'ecommerce', site: 'argos.co.uk', url: 'https://www.argos.co.uk', goal: 'Find Nintendo Switch OLED price and stock status', expect: 'answer' },
  { id: 5, category: 'ecommerce', site: 'selfridges.com', url: 'https://www.selfridges.com', goal: 'Search for Yves Saint Laurent Libre perfume price', expect: 'answer' },
  { id: 6, category: 'ecommerce', site: 'harveynichols.com', url: 'https://www.harveynichols.com', goal: 'Find Balenciaga sneakers price', expect: 'answer' },
  { id: 7, category: 'ecommerce', site: 'boots.com', url: 'https://www.boots.com', goal: 'Look up Olay Regenerist serum and customer rating', expect: 'answer' },
  { id: 8, category: 'ecommerce', site: 'spacenk.com', url: 'https://www.spacenk.com', goal: 'Search MAC Fix+ price', expect: 'answer' },

  // Tech & Gadgets
  { id: 9, category: 'tech', site: 'apple.com', url: 'https://www.apple.com/uk', goal: 'Find iPhone 15 Pro Max starting price', expect: 'answer' },
  { id: 10, category: 'tech', site: 'samsung.com', url: 'https://www.samsung.com/uk', goal: 'Look up Galaxy S24 Ultra specs and price', expect: 'answer' },
  { id: 11, category: 'tech', site: 'scan.co.uk', url: 'https://www.scan.co.uk', goal: 'Search RTX 4090 graphics card availability', expect: 'answer' },
  { id: 12, category: 'tech', site: 'box.co.uk', url: 'https://www.box.co.uk', goal: 'Find DJI Mini 4 Pro drone price', expect: 'answer' },
  { id: 13, category: 'tech', site: 'overclockers.co.uk', url: 'https://www.overclockers.co.uk', goal: 'Look up Intel Core i9-14900KS price', expect: 'answer' },
  { id: 14, category: 'tech', site: 'cclonline.com', url: 'https://www.cclonline.com', goal: 'Search Dell XPS 15 laptop price', expect: 'answer' },

  // Fashion & Clothing
  { id: 15, category: 'fashion', site: 'asos.com', url: 'https://www.asos.com', goal: 'Find Nike Air Force 1 white size 8 price', expect: 'answer' },
  { id: 16, category: 'fashion', site: 'zara.com', url: 'https://www.zara.com/uk', goal: 'Look up linen shirt price on Zara', expect: 'answer' },
  { id: 17, category: 'fashion', site: 'hm.com', url: 'https://www2.hm.com/en_gb', goal: 'Search oversized blazer colors on H&M', expect: 'answer' },
  { id: 18, category: 'fashion', site: 'uniqlo.com', url: 'https://www.uniqlo.com/uk', goal: 'Find heattech thermal leggings price', expect: 'answer' },
  { id: 19, category: 'fashion', site: 'asos.com', url: 'https://www.asos.com', goal: 'Look up mom jeans price', expect: 'answer', tags: ['topshop-proxy'] },

  // Home & Garden
  { id: 20, category: 'home', site: 'dunelm.com', url: 'https://www.dunelm.com', goal: 'Find grey corner sofa price and dimensions', expect: 'answer' },
  { id: 21, category: 'home', site: 'made.com', url: 'https://www.made.com', goal: 'Look up wooden dining table price', expect: 'answer' },
  { id: 22, category: 'home', site: 'next.co.uk', url: 'https://www.next.co.uk', goal: 'Search bedding set king size price', expect: 'answer' },
  { id: 23, category: 'home', site: 'wayfair.co.uk', url: 'https://www.wayfair.co.uk', goal: 'Find standing desk price range', expect: 'answer' },
  { id: 24, category: 'home', site: 'johnlewis.com', url: 'https://www.johnlewis.com', goal: 'Look up Le Creuset Dutch oven price', expect: 'answer' },

  // Books & Media
  { id: 25, category: 'books', site: 'waterstones.com', url: 'https://www.waterstones.com', goal: 'Search Lessons in Chemistry book price', expect: 'answer' },
  { id: 26, category: 'books', site: 'amazon.co.uk', url: 'https://www.amazon.co.uk', goal: 'Find The Thursday Murder Club hardback price', expect: 'answer' },
  { id: 27, category: 'books', site: 'bookdepository.com', url: 'https://www.bookdepository.com', goal: 'Look up Fourth Wing availability', expect: 'answer' },
  { id: 28, category: 'books', site: 'foyles.co.uk', url: 'https://www.foyles.co.uk', goal: 'Search Educated by Tara Westover price', expect: 'answer' },

  // Food & Groceries
  { id: 29, category: 'grocery', site: 'tesco.com', url: 'https://www.tesco.com/groceries', goal: 'Find Lurpak butter 250g price', expect: 'answer' },
  { id: 30, category: 'grocery', site: 'sainsburys.co.uk', url: 'https://www.sainsburys.co.uk', goal: 'Search Coca-Cola 2L price', expect: 'answer' },
  { id: 31, category: 'grocery', site: 'waitrose.com', url: 'https://www.waitrose.com', goal: 'Look up Cote d\'Or chocolate price', expect: 'answer' },
  { id: 32, category: 'grocery', site: 'iceland.co.uk', url: 'https://www.iceland.co.uk', goal: 'Find frozen fish fillets price', expect: 'answer' },
  { id: 33, category: 'grocery', site: 'ocado.com', url: 'https://www.ocado.com', goal: 'Search organic free-range eggs price', expect: 'answer' },

  // Sports & Outdoor
  { id: 34, category: 'sports', site: 'jdsports.co.uk', url: 'https://www.jdsports.co.uk', goal: 'Find Adidas Ultraboost 23 price', expect: 'answer' },
  { id: 35, category: 'sports', site: 'decathlon.co.uk', url: 'https://www.decathlon.co.uk', goal: 'Look up yoga mat price', expect: 'answer' },
  { id: 36, category: 'sports', site: 'sportsdirect.com', url: 'https://www.sportsdirect.com', goal: 'Search football boots budget price', expect: 'answer' },
  { id: 37, category: 'sports', site: 'wiggle.com', url: 'https://www.wiggle.com', goal: 'Find road bike helmet price', expect: 'answer' },
  { id: 38, category: 'sports', site: 'gooutdoors.co.uk', url: 'https://www.gooutdoors.co.uk', goal: 'Look up tent 2-person price', expect: 'answer' },

  // Beauty & Personal Care
  { id: 39, category: 'beauty', site: 'sephora.co.uk', url: 'https://www.sephora.co.uk', goal: 'Find Charlotte Tilbury Red Carpet Red lipstick price', expect: 'answer' },
  { id: 40, category: 'beauty', site: 'cultbeauty.co.uk', url: 'https://www.cultbeauty.co.uk', goal: 'Search La Roche-Posay thermal spring water price', expect: 'answer' },
  { id: 41, category: 'beauty', site: 'beautylish.com', url: 'https://www.beautylish.com', goal: 'Look up Dyson Supersonic hair dryer price', expect: 'answer' },
  { id: 42, category: 'beauty', site: 'spacenk.com', url: 'https://www.spacenk.com', goal: 'Find Augustinus Bader face cream price', expect: 'answer' },

  // Edge Cases & Complex
  { id: 43, category: 'edge', site: 'currys.co.uk', url: 'https://www.currys.co.uk', goal: 'Find Samsung 65-inch QLED TV price on Currys', expect: 'answer', tags: ['cross-site-part'] },
  { id: 44, category: 'edge', site: 'argos.co.uk', url: 'https://www.argos.co.uk', goal: 'Look up PlayStation 5 availability and stock', expect: 'answer' },
  { id: 45, category: 'edge', site: 'johnlewis.com', url: 'https://www.johnlewis.com', goal: 'Search Sony PS5 Pro UK launch edition availability if out of stock', expect: 'answer', tags: ['oos'] },
  { id: 46, category: 'edge', site: 'johnlewis.com', url: 'https://www.johnlewis.com', goal: 'Find Pikkii Love Letters Kit price', expect: 'answer', tags: ['tier0-baseline'] },
];