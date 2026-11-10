import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMix, falloff, direction, DEFAULTS } from '../public/audio-model.js';

const at = (x, y, extra = {}) => ({ x, y, z: 0, yaw: 0, alive: true, ...extra });

test('falloff is full inside near, silent past far, monotonic between', () => {
  assert.equal(falloff(0), 1);
  assert.equal(falloff(DEFAULTS.near), 1);
  assert.equal(falloff(DEFAULTS.far), 0);
  let prev = 1;
  for (let d = DEFAULTS.near; d <= DEFAULTS.far; d += 50) { const g = falloff(d); assert.ok(g <= prev); prev = g; }
});

test('pan follows Source axes: +y is to the left when facing +x', () => {
  assert.ok(direction(at(0, 0), at(0, 500)).pan < -0.99);  // left
  assert.ok(direction(at(0, 0), at(0, -500)).pan > 0.99);  // right
  assert.ok(Math.abs(direction(at(0, 0), at(500, 0)).pan) < 1e-9);  // ahead
  // turn to face +y (yaw 90): a source at +y is now straight ahead
  assert.ok(Math.abs(direction(at(0, 0, { yaw: 90 }), at(0, 500)).pan) < 1e-9);
});

test('living listener: distance, direction, walls', () => {
  const mix = computeMix(at(0, 0), { near: at(100, 0), mid: at(0, 800), far: at(5000, 0), wall: at(0, -800, { occluded: true }) }, true);
  assert.equal(mix.near.g, 1);
  assert.ok(mix.mid.g > 0 && mix.mid.g < 1 && mix.mid.p < 0);
  assert.deepEqual(mix.far, { g: 0, p: 0 });
  assert.ok(mix.wall.g < mix.mid.g && mix.wall.p > 0);
});

test('the living never hear the dead; spectators hear each other and the living', () => {
  const live = computeMix(at(0, 0), { ghost: at(10, 0, { alive: false }) }, true);
  assert.equal(live.ghost.g, 0);
  const dead = computeMix(at(0, 0, { alive: false }), { ghost: at(9999, 0, { alive: false }), alive: at(9999, 0) }, true);
  assert.equal(dead.ghost.g, 1);
  assert.equal(dead.alive.g, DEFAULTS.deadHearLiving);
});

test('outside a round everyone hears everyone, and output has no coordinates', () => {
  const mix = computeMix(at(0, 0), { a: at(9000, 0, { alive: false }), b: null }, false);
  assert.deepEqual(mix, { a: { g: 1, p: 0 }, b: { g: 1, p: 0 } });
  const live = computeMix(at(0, 0), { a: at(300, 300) }, true);
  assert.deepEqual(Object.keys(live.a).sort(), ['g', 'p']);
});
