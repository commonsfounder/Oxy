'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractPrice,
  extractProductName,
  extractFirstProductUrl,
  _normalizePrice
} = require('../../api/services/browser-price-parser');

test('extractPrice pulls from JSON-LD Product offers.price (string)', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Adidas Joggers",
      "offers": { "@type": "Offer", "price": "27.00", "priceCurrency": "GBP" }
    }
    </script>`;
  assert.equal(extractPrice(html), '£27.00');
});

test('extractPrice pulls from JSON-LD with offers array and numeric price', () => {
  const html = `
    <script type="application/ld+json">{"@type":"Product","offers":[{"price":39.99,"priceCurrency":"GBP"}]}</script>`;
  assert.equal(extractPrice(html), '£39.99');
});

test('extractPrice falls back through og:price then microdata', () => {
  const og = `<meta property="og:price:amount" content="15.50"><meta property="og:price:currency" content="GBP">`;
  assert.equal(extractPrice(og), '£15.50');

  const micro = `<div itemprop="offers" itemscope><meta itemprop="price" content="9.99"></div>`;
  assert.equal(extractPrice(micro), '£9.99');

  const microText = `<span itemprop="price">£123</span>`;
  assert.equal(extractPrice(microText), '£123');
});

test('extractPrice prefers JSON-LD over og/meta', () => {
  const html = `
    <script type="application/ld+json">{"@type":"Product","offers":{"price":"42.00","priceCurrency":"GBP"}}</script>
    <meta property="og:price:amount" content="99.99">
  `;
  assert.equal(extractPrice(html), '£42.00');
});

test('normalizePrice handles various formats and adds £ for UK', () => {
  assert.equal(_normalizePrice('39.99', 'GBP'), '£39.99');
  assert.equal(_normalizePrice(' 1,234.50 '), '£1234.50'); // thousands stripped for simplicity; retail prices are fine
  assert.equal(_normalizePrice('27'), '£27');
  assert.equal(_normalizePrice('£27.00'), '£27.00');
});

test('extractProductName pulls from JSON-LD, og:title, or h1', () => {
  const jl = `<script type="application/ld+json">{"@type":"Product","name":"Essential Joggers"}</script>`;
  assert.equal(extractProductName(jl), 'Essential Joggers');

  const og = `<meta property="og:title" content="Cordless Drill | Screwfix">`;
  assert.match(extractProductName(og), /Cordless Drill/);

  const h1 = `<h1>White Matt Emulsion Paint</h1>`;
  assert.equal(extractProductName(h1), 'White Matt Emulsion Paint');
});

test('extractFirstProductUrl finds strong product signals and returns absolute', () => {
  const html = `
    <a href="/search">bad</a>
    <a href="/p1234567">good john lewis</a>
    <a href="https://www.johnlewis.com/other">also</a>
  `;
  const u = extractFirstProductUrl(html, 'https://www.johnlewis.com');
  assert.ok(u && u.includes('/p1234567'));
  assert.ok(u.startsWith('https://'));
});

test('extractFirstProductUrl skips nav/cart/search and prefers product paths', () => {
  const html = `
    <a href="/basket">basket</a>
    <a href="/mens/joggers/adidas/p98765">product</a>
  `;
  const u = extractFirstProductUrl(html, 'https://www.johnlewis.com/foo');
  assert.ok(u && u.includes('p98765'));
});

test('extractPrice returns null on garbage or no signals', () => {
  assert.equal(extractPrice('<html><body>no prices here</body></html>'), null);
  assert.equal(extractPrice(''), null);
  assert.equal(extractPrice(null), null);
});

test('extractPrice falls back to visible £ text prices (common on many retail sites)', () => {
  const listing = `<div class="product"><a href="/prod/123">Cool Shirt</a> <span class="price">£22.50</span></div>`;
  assert.equal(extractPrice(listing), '£22.50');

  const withComma = `Only £1,299.00 today`;
  assert.equal(extractPrice(withComma), '£1299.00');

  // Should prefer substantial prices over tiny ones (delivery, "from")
  const withTiny = `Delivery £1.50 • Main item £45`;
  assert.equal(extractPrice(withTiny), '£45');
});

test('extractFirstProductUrl uses price proximity to find better links on weak markup', () => {
  const html = `
    <div>
      <a href="/foo/nav">nav</a>
      <a href="/products/abc123">Shirt</a>
      <span>£35</span>
    </div>
  `;
  const u = extractFirstProductUrl(html, 'https://example.com/search');
  assert.ok(u && u.includes('abc123'), 'should have picked link before the price');
});
