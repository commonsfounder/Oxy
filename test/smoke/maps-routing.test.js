const assert = require('node:assert/strict');
const test = require('node:test');

const { chooseBestTripRoute } = require('../../connectors/maps');

// Build a minimal Google Directions "route" the scorer understands: it reads
// legs[0].duration.value and each step's transit_details.line.vehicle.type
// (HEAVY_RAIL marks a rail leg) plus departure/arrival values.
function route({ durationSeconds, rail }) {
  return {
    legs: [{
      duration: { value: durationSeconds },
      steps: [{
        transit_details: {
          line: { vehicle: { type: rail ? 'HEAVY_RAIL' : 'BUS' }, name: rail ? 'Train' : 'Bus' },
          departure_stop: { name: 'A' },
          arrival_stop: { name: 'B' },
          departure_time: { value: 0 },
          arrival_time: { value: durationSeconds }
        }
      }]
    }]
  };
}

test('a sane bus route beats a wildly longer rail route (Apsley → Eurostar bug)', () => {
  const saneBus = route({ durationSeconds: 40 * 60, rail: false });   // 40 min coach
  const eurostar = route({ durationSeconds: 5 * 3600, rail: true });   // 5 hr via rail

  const best = chooseBestTripRoute([eurostar, saneBus]);
  assert.equal(best, saneBus, 'scorer must not pick a multi-hour rail detour over a 40-min route');
});

test('rail still wins when timings are comparable', () => {
  const bus = route({ durationSeconds: 45 * 60, rail: false });       // 45 min coach
  const train = route({ durationSeconds: 42 * 60, rail: true });      // 42 min train

  const best = chooseBestTripRoute([bus, train]);
  assert.equal(best, train, 'rail keeps a mild preference over an equal-ish coach');
});
