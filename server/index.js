// ProxVoice server: serves the web client, relays WebRTC signaling between players,
// receives game state from the GMod addon, and pushes each player their personal mix.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { computeMix } from '../public/audio-model.js';
import { loadEnv } from './env.js';

loadEnv();
const PORT = Number(process.env.PORT || 8090);
const SECRET = process.env.BRIDGE_SECRET || '';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CODE_TTL_MS = 10 * 60 * 1000;

if (!SECRET) console.warn('[proxvoice] WARNING: BRIDGE_SECRET is empty; anyone can post game events.');

// ---------- state ----------
/** peerId -> { ws, name, code, codeAt, steamid } */
const clients = new Map();
/** steamid -> peerId */
const bySteam = new Map();
/** steamid -> { x,y,z,yaw,alive,name } from the latest position batch */
const players = new Map();
/** Set of "sidA|sidB" (sorted) pairs with a wall between them */
let walls = new Set();
let roundActive = false;

const newId = () => crypto.randomBytes(6).toString('hex');
const newCode = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let c; do { c = Array.from(crypto.randomBytes(5), b => abc[b % abc.length]).join(''); }
  while ([...clients.values()].some(x => x.code === c));
  return c;
};
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** resume token -> { steamid, name }: lets a refreshed tab reconnect without a new code */
const resume = new Map();

function bind(id, c, sid, token) {
  // One browser per Steam account: kick an older session
  const old = bySteam.get(sid);
  if (old && old !== id && clients.has(old)) {
    send(clients.get(old).ws, { t: 'kicked', reason: 'You joined voice from another tab or browser.' });
    clients.get(old).ws.close();
  }
  c.steamid = sid; c.code = null;
  bySteam.set(sid, id);
  token = token || crypto.randomBytes(16).toString('hex');
  resume.set(token, { steamid: sid, name: c.name });
  send(c.ws, { t: 'linked', name: c.name, token });
  console.log(`[proxvoice] linked ${c.name} (${sid}) -> peer ${id}`);
  broadcastPeers();
}

function linkedPeers() {
  return [...clients.entries()].filter(([, c]) => c.steamid).map(([id, c]) => ({ id, name: c.name }));
}
function broadcastPeers() {
  const list = linkedPeers();
  for (const [, c] of clients) if (c.steamid) send(c.ws, { t: 'peers', list });
}

// ---------- mix ----------
function pushMixes() {
  for (const [id, c] of clients) {
    if (!c.steamid) continue;
    const me = players.get(c.steamid);
    const others = new Map();
    for (const [oid, oc] of clients) {
      if (oid === id || !oc.steamid) continue;
      const p = players.get(oc.steamid);
      others.set(oid, p ? { ...p, occluded: walls.has(pairKey(c.steamid, oc.steamid)) } : null);
    }
    send(c.ws, {
      t: 'mix',
      round: roundActive,
      alive: me ? me.alive : true,
      peers: computeMix(me, others, roundActive),
    });
  }
}

// ---------- game events (from the GMod addon) ----------
function handleGameEvent(ev) {
  switch (ev.type) {
    case 'round_start':
      roundActive = true;
      break;
    case 'round_end':
      roundActive = false;
      for (const p of players.values()) p.alive = true;
      break;
    case 'state': {
      // Full snapshot sent ~10 Hz: { players: [{steamid64, name, x,y,z, yaw, alive}], walls: [[sidA,sidB],...] }
      if (typeof ev.round === 'boolean') roundActive = ev.round;
      const seen = new Set();
      for (const p of ev.players || []) {
        if (!p.steamid64) continue;
        seen.add(p.steamid64);
        players.set(p.steamid64, {
          x: +p.x || 0, y: +p.y || 0, z: +p.z || 0, yaw: +p.yaw || 0,
          alive: p.alive !== false, name: String(p.name || ''),
        });
      }
      for (const sid of players.keys()) if (!seen.has(sid)) players.delete(sid);
      walls = new Set((ev.walls || []).map(([a, b]) => pairKey(String(a), String(b))));
      break;
    }
    case 'voice_link': {
      const code = String(ev.code || '').toUpperCase().trim();
      const sid = ev.player && String(ev.player.steamid64 || '');
      const entry = [...clients.entries()].find(([, c]) => c.code === code);
      if (!entry || !sid) return { linked: false, reason: 'code_not_found' };
      const [id, c] = entry;
      if (Date.now() - c.codeAt > CODE_TTL_MS) return { linked: false, reason: 'code_expired' };
      if (ev.player.name) c.name = String(ev.player.name).slice(0, 32);
      bind(id, c, sid);
      return { linked: true, name: c.name };
    }
    default:
      return { ignored: true };
  }
  pushMixes();
  return {};
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/events') {
    if (req.headers['x-bridge-secret'] !== SECRET) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1e6) return res.destroy(); }
    let ev; try { ev = JSON.parse(body); } catch { res.writeHead(400); return res.end('{"error":"invalid_json"}'); }
    const result = handleGameEvent(ev) || {};
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ...result }));
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, clients: clients.size, linked: bySteam.size, players: players.size, round: roundActive }));
  }
  if (url.pathname === '/config.json') {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (process.env.TURN_URL) iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ iceServers }));
  }
  // static files
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket: browser clients ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  const id = newId();
  const c = { ws, name: 'Player', code: newCode(), codeAt: Date.now(), steamid: null };
  clients.set(id, c);
  send(ws, { t: 'welcome', id, code: c.code });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello') {
      if (typeof m.name === 'string') c.name = m.name.slice(0, 32) || c.name;
      const r = typeof m.token === 'string' && resume.get(m.token);
      if (r) { c.name = r.name; bind(id, c, r.steamid, m.token); }
    }
    else if (m.t === 'newcode' && !c.steamid) { c.code = newCode(); c.codeAt = Date.now(); send(ws, { t: 'welcome', id, code: c.code }); }
    else if (m.t === 'signal' && c.steamid) {
      // Relay WebRTC offer/answer/ICE to another linked peer
      const target = clients.get(m.to);
      if (target && target.steamid) send(target.ws, { t: 'signal', from: id, data: m.data });
    }
  });
  ws.on('close', () => {
    clients.delete(id);
    if (c.steamid && bySteam.get(c.steamid) === id) bySteam.delete(c.steamid);
    if (c.steamid) broadcastPeers();
  });
});

server.listen(PORT, () => console.log(`[proxvoice] listening on http://localhost:${PORT}`));
