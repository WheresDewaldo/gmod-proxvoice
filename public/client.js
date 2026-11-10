// Browser client: mic capture, WebRTC mesh between linked players, per-peer gain + pan
// driven by the "mix" messages the server sends ~10 times a second.
const $ = id => document.getElementById(id);
const SMOOTH = 0.08; // seconds; gain/pan glide so 10 Hz updates don't zipper

let ws, myId, ctx, micStream, iceServers = [];
let muted = false, kicked = false;
/** peerId -> { pc, name, gain, pan, level, analyser, el, gainEl } */
const peers = new Map();

// ---------- setup ----------
try { $('name').value = localStorage.getItem('pv-name') || ''; } catch {}

async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const sel = $('mic'), cur = sel.value;
    sel.innerHTML = '<option value="">Default microphone</option>' +
      devs.map(d => `<option value="${d.deviceId}">${escapeHtml(d.label || 'Microphone')}</option>`).join('');
    sel.value = cur;
    // Pre-select a known AI noise-removal mic if present
    if (!cur) { const ai = devs.find(d => /broadcast|krisp|rtx voice/i.test(d.label)); if (ai) { sel.value = ai.deviceId; $('ns').checked = false; } }
  } catch {}
}
listMics();

$('join').onclick = async () => {
  $('setup-err').hidden = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: $('mic').value ? { exact: $('mic').value } : undefined,
        noiseSuppression: $('ns').checked,
        echoCancellation: $('ec').checked,
        autoGainControl: true,
      },
    });
  } catch (e) {
    $('setup-err').textContent = `Couldn't open the microphone (${e.name}). Allow mic access in the address bar and try again.`;
    $('setup-err').hidden = false;
    return;
  }
  await listMics(); // labels are available after permission
  try { localStorage.setItem('pv-name', $('name').value); } catch {}
  ctx = new AudioContext();
  meterLocal();
  iceServers = (await (await fetch('config.json')).json()).iceServers;
  connect();
  $('setup').hidden = true;
  $('link').hidden = false;
};

$('mute').onclick = () => {
  muted = !muted;
  micStream.getAudioTracks().forEach(t => (t.enabled = !muted));
  $('mute').textContent = muted ? 'Unmute mic' : 'Mute mic';
  $('mute').classList.toggle('on', muted);
};
$('newcode').onclick = () => ws && ws.send(JSON.stringify({ t: 'newcode' }));

// ---------- signaling ----------
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let token = null; try { token = sessionStorage.getItem('pv-token'); } catch {}
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: $('name').value || 'Player', token }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') { myId = m.id; $('code').textContent = m.code; }
    else if (m.t === 'linked') { try { sessionStorage.setItem('pv-token', m.token); } catch {} $('link').hidden = true; $('live').hidden = false; $('me-name').textContent = m.name; }
    else if (m.t === 'peers') syncPeers(m.list);
    else if (m.t === 'signal') onSignal(m.from, m.data);
    else if (m.t === 'mix') applyMix(m);
    else if (m.t === 'kicked') { kicked = true; alertBox(m.reason); }
  };
  ws.onclose = () => {
    for (const id of [...peers.keys()]) dropPeer(id);
    $('live').hidden = true;
    if (kicked) return;
    // Reconnect; the server hands out a fresh code, so the player re-links with !voice
    $('link').hidden = false;
    setTimeout(connect, 2000);
  };
}
const signal = (to, data) => ws.send(JSON.stringify({ t: 'signal', to, data }));

function syncPeers(list) {
  const want = new Set(list.map(p => p.id).filter(id => id !== myId));
  for (const id of peers.keys()) if (!want.has(id)) dropPeer(id);
  for (const p of list) {
    if (p.id === myId) continue;
    const ex = peers.get(p.id);
    if (ex) { ex.name = p.name; continue; }
    const peer = makePeer(p.id, p.name);
    // Lower id makes the offer so exactly one side starts negotiation
    if (myId < p.id) negotiate(peer, p.id);
  }
  renderPeers();
}

function makePeer(id, name) {
  const pc = new RTCPeerConnection({ iceServers });
  micStream.getTracks().forEach(t => pc.addTrack(t, micStream));
  const gain = ctx.createGain(); gain.gain.value = 0;
  const pan = ctx.createStereoPanner();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
  gain.connect(pan).connect(ctx.destination);
  gain.connect(analyser);
  const peer = { pc, name, gain, pan, analyser, g: 0 };
  pc.onicecandidate = e => e.candidate && signal(id, { ice: e.candidate });
  pc.ontrack = e => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    // Chrome only feeds remote WebRTC audio into Web Audio if it's also attached to a media element
    const a = new Audio(); a.muted = true; a.srcObject = stream; a.play().catch(() => {});
    peer.audioEl = a;
    ctx.createMediaStreamSource(stream).connect(gain);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && myId < id) negotiate(peer, id, true);
    renderPeers();
  };
  peers.set(id, peer);
  return peer;
}

async function negotiate(peer, id, restart = false) {
  const offer = await peer.pc.createOffer({ iceRestart: restart });
  await peer.pc.setLocalDescription(offer);
  signal(id, { sdp: peer.pc.localDescription });
}

async function onSignal(from, data) {
  const peer = peers.get(from);
  if (!peer) return;
  try {
    if (data.sdp) {
      await peer.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        signal(from, { sdp: peer.pc.localDescription });
      }
    } else if (data.ice) {
      await peer.pc.addIceCandidate(data.ice);
    }
  } catch (e) { console.warn('signal error', e); }
}

function dropPeer(id) {
  const p = peers.get(id); if (!p) return;
  p.pc.close(); p.gain.disconnect(); p.pan.disconnect();
  if (p.audioEl) p.audioEl.srcObject = null;
  peers.delete(id);
  renderPeers();
}

// ---------- mix ----------
function applyMix(m) {
  const t = ctx.currentTime;
  for (const [id, peer] of peers) {
    const v = m.peers[id] || { g: 0, p: 0 };
    peer.g = v.g;
    peer.gain.gain.setTargetAtTime(v.g, t, SMOOTH);
    peer.pan.pan.setTargetAtTime(v.p, t, SMOOTH);
  }
  const st = $('status');
  st.textContent = !m.round ? 'Lobby' : m.alive ? 'Alive' : 'Spectating';
  st.dataset.state = !m.round ? 'lobby' : m.alive ? 'alive' : 'dead';
}

// ---------- UI ----------
function renderPeers() {
  const ul = $('peers');
  if (!peers.size) { ul.innerHTML = '<li class="empty">Nobody else is linked yet.</li>'; return; }
  ul.innerHTML = '';
  for (const [, p] of peers) {
    const li = document.createElement('li');
    const state = p.pc.connectionState;
    li.innerHTML = `<span class="pname">${escapeHtml(p.name)}</span>
      <span class="conn" data-s="${state}">${state === 'connected' ? '' : state}</span>
      <div class="bar" title="Volume to you"><i></i></div><div class="speak"></div>`;
    p.barEl = li.querySelector('.bar i'); p.speakEl = li.querySelector('.speak');
    ul.appendChild(li);
  }
}

function rms(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let s = 0; for (const v of buf) s += v * v;
  return Math.sqrt(s / buf.length);
}

function meterLocal() {
  const an = ctx.createAnalyser(); an.fftSize = 256;
  ctx.createMediaStreamSource(micStream).connect(an);
  const buf = new Float32Array(an.fftSize);
  const tick = () => {
    $('mylevel').style.width = Math.min(100, rms(an, buf) * 400) + '%';
    for (const [, p] of peers) {
      if (p.barEl) p.barEl.style.width = Math.round(p.g * 100) + '%';
      if (p.speakEl) p.speakEl.classList.toggle('on', rms(p.analyser, buf) > 0.01);
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function alertBox(msg) { $('setup-err').textContent = msg; $('setup-err').hidden = false; $('setup').hidden = false; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
