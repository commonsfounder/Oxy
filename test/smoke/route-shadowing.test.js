const assert = require('node:assert/strict');
const test = require('node:test');

const app = require('../../api/index');

/*
 * Express dispatches to the first matching route, so a concrete path registered after a
 * parameterised one on the same prefix is dead code — and silently so: the param route handles
 * the request with the literal segment as an id, which typically ends in a 403 rather than a 404.
 *
 * Asserted as a property, so a new concrete route added below a param route fails here rather
 * than in production.
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
