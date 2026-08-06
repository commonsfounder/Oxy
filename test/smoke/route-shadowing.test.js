const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');

/*
 * Express dispatches to the FIRST route whose pattern matches, so a concrete path
 * registered after a parameterised one on the same prefix is dead code. This is silent:
 * the request is handled by the param route, which sees the literal segment as an id.
 *
 * `/memory/recent-entities` sat 4,455 lines below `/memory/:userId`, so every call was
 * answered by the param route with userId="recent-entities". That string passes the
 * userId format check (letters and hyphens), so it reached the ownership comparison and
 * returned 403 to the iOS Home view on every 90s poll. `/connectors/agent-card` was dead
 * the same way, breaking the stored-card lookup in Payments.
 *
 * This asserts the property rather than the two known cases, so a new concrete route
 * added below an existing param route fails here instead of in production.
 */
function routeLayers() {
  const stack = (app.router && app.router.stack) || app._router.stack;
  return stack.filter(layer => layer.route && typeof layer.route.path === 'string');
}

function shadowedRoutes() {
  const layers = routeLayers();
  const shadowed = [];
  layers.forEach((layer, index) => {
    const path = layer.route.path;
    if (path.includes(':')) return;
    for (let earlier = 0; earlier < index; earlier += 1) {
      const candidate = layers[earlier];
      if (!candidate.route.path.includes(':')) continue;
      const sharedMethod = Object.keys(layer.route.methods)
        .find(method => candidate.route.methods[method]);
      if (!sharedMethod) continue;
      if (typeof candidate.match === 'function' && candidate.match(path)) {
        shadowed.push(`${sharedMethod.toUpperCase()} ${path} is shadowed by ${candidate.route.path}`);
        return;
      }
    }
  });
  return shadowed;
}

test('no concrete route is shadowed by an earlier parameterised route', () => {
  assert.deepEqual(shadowedRoutes(), []);
});

test('the routes that were shadowed in production resolve to their own handlers', () => {
  for (const path of ['/memory/recent-entities', '/connectors/agent-card']) {
    const firstMatch = routeLayers()
      .find(layer => layer.route.methods.get && typeof layer.match === 'function' && layer.match(path));
    assert.ok(firstMatch, `no GET route matches ${path}`);
    assert.equal(
      firstMatch.route.path,
      path,
      `GET ${path} dispatches to ${firstMatch.route.path}, so its own handler is unreachable`
    );
  }
});
