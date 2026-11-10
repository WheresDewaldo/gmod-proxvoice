# ProxVoice

Positional proximity voice chat for Garry's Mod TTT, in the browser.

Voices fade smoothly with distance, pan left and right with where people are standing,
and get muffled through walls. Dead players talk to each other without the living hearing them.
There are no channel moves and no join sounds.

## How it works

```
GMod server ──(positions, facing, alive, walls · 10 Hz)──▶ ProxVoice server ──(volume + pan per player)──▶ each browser
                                                                    ▲                                         │
                                                                    └──────── WebRTC signaling ───────────────┘
                                                    browsers send voice directly to each other (WebRTC)
```

- **`addon/`**: GMod server addon. Sends a snapshot of every player 10 times a second and traces
  for walls between living players in earshot. Handles `!voice CODE` in chat.
- **`server/`**: Node server. Links browsers to Steam accounts, relays WebRTC setup messages, and
  turns positions into a personal mix for each listener. Clients only ever receive volume and pan
  numbers, never coordinates, so the page can't be used to find traitors.
- **`public/`**: the web page players keep open, plus an offline demo (`/demo.html`).
- **`public/audio-model.js`**: the volume model (distance falloff, direction, walls, dead/alive rules),
  shared by the server and the demo. Tuning lives in `DEFAULTS` at the top.

## Try it locally

```bash
npm install
cp .env.sample .env        # set BRIDGE_SECRET to anything
npm start                  # http://localhost:8090
```

- **Hear the model with no game:** open http://localhost:8090/demo.html and press Start audio.
- **Real voice between two tabs:** open http://localhost:8090 in two tabs (or two browsers), join in
  both, then run `npm run fake-game -- CODE1 CODE2` with the codes they show. The fake players orbit
  each other and you'll hear each tab fade in and out. Use headphones to avoid feedback.

Run the tests with `npm test`.

## Run it for real

1. **HTTPS is required.** Browsers only allow microphone access on `https://` (or localhost).
   `docker-compose.yml` includes Caddy, which gets a certificate automatically once a domain points
   at the machine. Set `DOMAIN`, fill in `.env`, then `docker compose up -d`.
2. **Install the addon** by copying `addon/` into `garrysmod/addons/proxvoice/`, then in `server.cfg`:
   ```
   proxvoice_url "http://<proxvoice host>:8090"
   proxvoice_secret "<same as BRIDGE_SECRET>"
   proxvoice_public_url "https://voice.example.com"
   sv_voiceenable 0          // turn off in-game voice so nobody is heard twice
   ```
3. **Players** open the public URL, pick their mic, join, and type `!voice CODE` in game chat.
   Refreshing the tab reconnects without a new code.

### Noise suppression

Players with NVIDIA Broadcast or the Krisp app should pick that microphone on the join screen and
untick *Browser noise suppression*. The page pre-selects a Broadcast/Krisp mic when it finds one.
Everyone else gets the browser's built-in suppression.

### Network notes

- Voice goes peer to peer. Most home connections work with the default STUN server. Players behind
  strict NAT need the TURN relay (`docker compose --profile turn up -d`, then set `TURN_*` in `.env`).
- Peer to peer means each player uploads their voice once per listener, which is fine up to roughly
  10 to 12 players. For bigger lobbies the next step is a media server such as LiveKit, so each
  player uploads once; the mixing model stays the same.

## Tuning

In `public/audio-model.js`:

| Setting | Default | Meaning |
|---|---|---|
| `near` | 200 | Full volume inside this many Source units |
| `far` | 1600 | Silent beyond this |
| `panAmount` | 0.8 | How far left/right voices go |
| `rearDamp` | 0.15 | Volume drop for voices directly behind you |
| `deadHearLiving` | 0.6 | Volume spectators hear the living at (0 to disable) |
| `occlusionDamp` | 0.45 | Volume multiplier through walls |

If you change `far`, set the addon's `proxvoice_occlusion_range` to match.

## Status

Prototype. Tested end to end with two headless browsers and the fake game (connection, audio flow,
distance fade). The GMod addon has not been run on a live server yet.
