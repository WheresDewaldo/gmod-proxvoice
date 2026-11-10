// Shared by the server (computes each listener's mix) and the browser demo.
// Pure functions only: no DOM, no Node APIs.

export const DEFAULTS = {
  near: 200,              // Source units: full volume inside this distance
  far: 1600,              // silent beyond this distance
  panAmount: 0.8,         // 0 = mono, 1 = hard left/right
  rearDamp: 0.15,         // slight volume drop for voices directly behind you
  deadHearLiving: 0.6,    // flat volume spectators hear the living at (0 to disable)
  occlusionDamp: 0.45,    // multiplier when a wall is between two players
};

/** Volume 0..1 for a distance in Source units. Smooth (no audible step at the edges). */
export function falloff(dist, near = DEFAULTS.near, far = DEFAULTS.far) {
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  const t = (dist - near) / (far - near);   // 0..1
  const s = 1 - t;
  return s * s * (3 - 2 * s);               // smoothstep, eased toward 0
}

/**
 * Stereo pan -1 (left) .. 1 (right) and a front/back factor for a source relative to a listener.
 * Source engine axes: +x forward at yaw 0, +y is to the LEFT, yaw is degrees counter-clockwise.
 */
export function direction(listener, source) {
  const dx = source.x - listener.x, dy = source.y - listener.y;
  if (dx === 0 && dy === 0) return { pan: 0, front: 1 };
  const rel = Math.atan2(dy, dx) - (listener.yaw || 0) * Math.PI / 180;
  return { pan: -Math.sin(rel), front: Math.cos(rel) };
}

/**
 * Compute what one listener should hear.
 * @param listener {x,y,z,yaw,alive}
 * @param others   Map/obj id -> {x,y,z,alive, occluded?}
 * @param roundActive  outside a round everyone hears everyone at full volume
 * @returns {[id]: {g, p}}  gain and pan per source. Never includes coordinates,
 *          so a client can't use it to locate players.
 */
export function computeMix(listener, others, roundActive, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = {};
  const entries = others instanceof Map ? others.entries() : Object.entries(others);
  for (const [id, src] of entries) {
    if (!roundActive || !listener) { out[id] = { g: 1, p: 0 }; continue; }
    if (!src) { out[id] = { g: 0, p: 0 }; continue; }
    if (!listener.alive) {
      // Spectators: hear other spectators fully, the living at a flat level
      out[id] = src.alive ? { g: o.deadHearLiving, p: 0 } : { g: 1, p: 0 };
      continue;
    }
    if (!src.alive) { out[id] = { g: 0, p: 0 }; continue; }  // the living never hear the dead
    const dz = (src.z || 0) - (listener.z || 0);
    const dist = Math.hypot(src.x - listener.x, src.y - listener.y, dz);
    let g = falloff(dist, o.near, o.far);
    if (g > 0) {
      const { pan, front } = direction(listener, src);
      if (front < 0) g *= 1 - o.rearDamp * -front;
      if (src.occluded) g *= o.occlusionDamp;
      // Pan less when close so a voice right next to you doesn't sit in one ear
      const closeness = Math.min(1, dist / (o.near * 2));
      out[id] = { g: round3(g), p: round3(pan * o.panAmount * closeness) };
    } else {
      out[id] = { g: 0, p: 0 };
    }
  }
  return out;
}

const round3 = v => Math.round(v * 1000) / 1000;
