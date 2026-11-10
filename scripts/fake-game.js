// Pretend to be a GMod server: links browser codes to fake Steam accounts and walks
// those players around a map so you can test real voice between two browser tabs/PCs.
//
//   npm run fake-game -- CODE1 CODE2 [CODE3...]
//
// Reads PORT and BRIDGE_SECRET from .env like the server does.
import { loadEnv } from '../server/env.js';
loadEnv();
const base = `http://127.0.0.1:${process.env.PORT || 8090}`;
const secret = process.env.BRIDGE_SECRET || '';
const codes = process.argv.slice(2);
if (!codes.length) { console.log('Usage: npm run fake-game -- CODE1 CODE2 ...'); process.exit(1); }

const post = body => fetch(`${base}/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': secret }, body: JSON.stringify(body),
}).then(r => r.json());

const players = codes.map((code, i) => ({
  steamid64: String(76561190000000000n + BigInt(i + 1)), name: `Tester${i + 1}`, code,
  angle: (i / codes.length) * Math.PI * 2, alive: true,
}));

for (const p of players) {
  const r = await post({ type: 'voice_link', code: p.code, player: { steamid64: p.steamid64, name: p.name } });
  console.log(`${p.name}: ${r.linked ? 'linked' : 'FAILED ' + r.reason}`);
}

// Players orbit a centre point; their distance swings between 100 and 2200 units every 20 s,
// so you hear each other fade in and out and move left/right.
console.log('Round started. Ctrl+C to stop.');
const t0 = Date.now();
setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  const r = 1150 - 1050 * Math.cos((t / 20) * Math.PI * 2);
  const snapshot = players.map((p, i) => {
    const a = p.angle + t * 0.15;
    const x = Math.cos(a) * r / 2, y = Math.sin(a) * r / 2;
    return { steamid64: p.steamid64, name: p.name, x, y, z: 0, yaw: (Math.atan2(-y, -x) * 180) / Math.PI, alive: true };
  });
  post({ type: 'state', round: true, players: snapshot, walls: [] }).catch(e => console.error(e.message));
  if (Math.round(t * 10) % 20 === 0) process.stdout.write(`\rapart: ${Math.round(r)} units   `);
}, 100);
