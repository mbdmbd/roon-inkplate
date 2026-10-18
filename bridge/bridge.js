'use strict';
/*
 * roon-inkplate-bridge
 *
 * Roon extension that watches one Roon zone and renders whatever is playing
 * into a ready-to-blit frame for an Inkplate 6PLUS in 3-bit mode. Runs on any
 * machine on the same network as the Roon core, in Docker or plain Node.js.
 * The Inkplate polls GET /frame; the bridge answers 304 when nothing changed.
 *
 *   GET  /frame        1024x758 frame, 4 bits/pixel (levels 0-7, 0 = black),
 *                      high nibble = left pixel. Headers: ETag, X-Frontlight (0-63),
 *                      X-Layout, X-Rotate (so the Inkplate can map touches)
 *   POST /control?action=playpause|next|previous|vol_up|vol_down|
 *                        light_toggle|light_up|light_down
 *   GET  /preview.png  what the panel should show, upright, for tuning
 *   GET  /status       JSON debug info
 *
 * Security: /control refuses browser requests (anything sending Origin or
 * Sec-Fetch-Site) and, if CONTROL_TOKEN is set, requests without a matching
 * X-Control-Token header. Every endpoint rejects Host names other than IP
 * addresses, localhost, *.local and ALLOWED_HOSTS (DNS-rebinding defence).
 *
 * Test the rendering without Roon or the Inkplate:
 *   node bridge.js --test cover.jpg "Track" "Artist" "Album"   -> preview.png
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const sharp = require('sharp');

// Files the bridge writes (Roon pairing token, settings) are private to its user.
process.umask(0o077);

// ---------- configuration (environment variables) ---------------------------

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

// Every setting is checked at startup; the bridge refuses to run on a bad value
// rather than guess (a negative VOLUME_STEP must never turn "down" into "up").
const configErrors = [];
function num(name, def, { min = -Infinity, max = Infinity, int = false } = {}) {
  const raw = env(name, def);
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    const range = [Number.isFinite(min) ? `>= ${min}` : '', Number.isFinite(max) ? `<= ${max}` : ''].filter(Boolean).join(' and ');
    configErrors.push(`${name} must be ${int ? 'a whole number' : 'a number'}${range ? ' ' + range : ''} (got "${raw}")`);
  }
  return v;
}
function oneOf(name, def, allowed) {
  const v = String(env(name, def));
  if (!allowed.includes(v)) configErrors.push(`${name} must be one of: ${allowed.join(', ')} (got "${v}")`);
  return v;
}

const CFG = {
  port: num('PORT', 8765, { min: 1, max: 65535, int: true }),
  zoneName: env('ZONE_NAME', ''),                                   // exact Roon zone name; empty = first playing zone
  graceSec: num('IDLE_GRACE_SEC', 120, { min: 0, max: 86400 }),     // how long paused/stopped before going dark
  frontlight: num('FRONTLIGHT', 20, { min: 0, max: 63, int: true }), // 0-63 while playing (starting level; touch adjusts it)
  lightStep: num('LIGHT_STEP', 5, { min: 1, max: 63, int: true }),  // frontlight change per swipe in the text area
  volumeStep: num('VOLUME_STEP', 5, { min: 0.1, max: 20 }),        // volume change per swipe (zone's units, usually dB)
  volumeMax: num('VOLUME_MAX', -30, { min: -200, max: 200 }),       // swipe-up never goes above this (zone's units)
  idleMode: oneOf('IDLE_MODE', 'blank', ['blank', 'keep']),         // white screen, or last cover unlit
  layout: oneOf('LAYOUT', 'portrait', ['portrait', 'landscape']),   // art above text, or art left
  rotate: Number(oneOf('ROTATE', '90', ['90', '270'])),             // portrait only: whichever is upright for you
  gamma: num('GAMMA', 1.0, { min: 0.2, max: 5 }),                   // >1 lightens midtones, <1 darkens
  showText: oneOf('SHOW_TEXT', '1', ['0', '1']) === '1',
  font: env('FONT', 'Sans'),                                        // any installed font family (fontconfig name)
  roonHost: env('ROON_HOST', ''),                                   // connect directly instead of discovery
  roonPort: num('ROON_PORT', 9330, { min: 1, max: 65535, int: true }),
  connectTimeoutSec: num('CONNECT_TIMEOUT_SEC', 20, { min: 3, max: 600 }),
  allowedHosts: env('ALLOWED_HOSTS', '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  controlTokenSet: false, // filled in below; the token itself is never shown
};

// Optional shared secret for POST /control (sent by the Inkplate as X-Control-Token).
const CONTROL_TOKEN = env('CONTROL_TOKEN', '');
CFG.controlTokenSet = Boolean(CONTROL_TOKEN);

if (configErrors.length) {
  console.error('Invalid configuration:\n  ' + configErrors.join('\n  '));
  process.exit(1);
}
if (CONTROL_TOKEN && CONTROL_TOKEN.length < 16) {
  console.warn('Warning: CONTROL_TOKEN is short; use at least 16 random characters (e.g. `openssl rand -hex 16`).');
}

// ---------- panel geometry ---------------------------------------------------

const W = 1024;                 // Inkplate 6PLUS native width
const H = 758;                  // native height
const ART = 758;                // square art edge, ~90 mm on this panel
const FRAME_BYTES = (W * H) / 2;
const LEVELS = 8;               // 3-bit greyscale
const WHITE = LEVELS - 1;

const PORTRAIT = CFG.layout === 'portrait';
const CW = PORTRAIT ? H : W;    // logical (upright) canvas size
const CH = PORTRAIT ? W : H;
const TEXT_BOX = PORTRAIT
  ? { x: 0, y: ART, w: CW, h: CH - ART }      // 758 x 266 strip under the art
  : { x: ART, y: 0, w: CW - ART, h: CH };     // 266 x 758 strip beside the art
const TEXT_PAD = 20;

// ---------- image helpers ----------------------------------------------------

// Serpentine Floyd-Steinberg error diffusion from 8-bit grey to 0..7.
function ditherToLevels(grey, w, h, gamma) {
  const buf = new Float32Array(w * h);
  const inv = 1 / gamma;
  for (let i = 0; i < buf.length; i++) buf[i] = 255 * Math.pow(grey[i] / 255, inv);

  const out = new Uint8Array(w * h);
  const step = 255 / WHITE;
  for (let y = 0; y < h; y++) {
    const ltr = (y & 1) === 0;
    const dir = ltr ? 1 : -1;
    for (let i = 0; i < w; i++) {
      const x = ltr ? i : w - 1 - i;
      const idx = y * w + x;
      const old = Math.min(255, Math.max(0, buf[idx]));
      const q = Math.round(old / step);
      out[idx] = q;
      const err = old - q * step;
      const xn = x + dir;
      const xp = x - dir;
      if (xn >= 0 && xn < w) buf[idx + dir] += (err * 7) / 16;
      if (y + 1 < h) {
        const below = idx + w;
        if (xp >= 0 && xp < w) buf[below - dir] += (err * 3) / 16;
        buf[below] += (err * 5) / 16;
        if (xn >= 0 && xn < w) buf[below + dir] += err / 16;
      }
    }
  }
  return out;
}

async function renderArt(imageBuf) {
  const { data } = await sharp(imageBuf)
    .flatten({ background: '#ffffff' })
    .resize(ART, ART, { fit: 'cover' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return ditherToLevels(data, ART, ART, CFG.gamma);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Track text comes from Roon, which takes it from files, streaming services and
// internet radio (where station operators control it). Strip control characters
// and cap the length so a hostile title can't make rendering expensive.
const MAX_LINE_CHARS = 200;
function cleanLine(s) {
  const chars = Array.from(String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim());
  return chars.length > MAX_LINE_CHARS ? chars.slice(0, MAX_LINE_CHARS - 1).join('') + '…' : chars.join('');
}

// Renders up to three lines of text into the box, shrinking until it fits.
async function renderText(lines, box) {
  const w = box.w - TEXT_PAD * 2;
  const h = box.h - TEXT_PAD * 2;
  const [l1, l2, l3] = lines.map(cleanLine);
  const base = PORTRAIT ? 1.0 : 0.85;
  let img = null;

  for (let scale = base; scale >= 0.4; scale -= 0.05) {
    const pt = (n) => Math.round(n * scale * 1024); // Pango size units at 72 dpi = px
    const parts = [];
    if (l1) parts.push(`<span size="${pt(52)}" weight="bold">${esc(l1)}</span>`);
    if (l2) parts.push(`<span size="${pt(40)}">${esc(l2)}</span>`);
    if (l3) parts.push(`<span size="${pt(34)}" style="italic">${esc(l3)}</span>`);
    if (!parts.length) return null;

    const { data, info } = await sharp({
      text: { text: parts.join('\n'), font: CFG.font, width: w, dpi: 72, wrap: 'word-char', align: 'centre', spacing: 6 },
    })
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true });

    img = { data, width: info.width, height: info.height };
    if (info.height <= h && info.width <= w) break;
  }

  // White box, black text, crop if it still overflows at minimum size.
  const out = new Uint8Array(box.w * box.h).fill(WHITE);
  const tw = Math.min(img.width, w);
  const th = Math.min(img.height, h);
  const ox = TEXT_PAD + Math.floor((w - tw) / 2);
  const oy = TEXT_PAD + Math.floor((h - th) / 2);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const v = img.data[y * img.width + x]; // 255 = ink
      out[(oy + y) * box.w + (ox + x)] = Math.round(((255 - v) / 255) * WHITE);
    }
  }
  return out;
}

function blit(canvas, src, sx, sy, sw, sh) {
  for (let y = 0; y < sh; y++) canvas.set(src.subarray(y * sw, (y + 1) * sw), (sy + y) * CW + sx);
}

async function composeFrame(imageBuf, lines) {
  const canvas = new Uint8Array(CW * CH).fill(WHITE);
  if (imageBuf) {
    blit(canvas, await renderArt(imageBuf), 0, 0, ART, ART);
  } else {
    // No artwork (radio, some streams): leave a thin outline where it would be.
    for (let i = 0; i < ART; i++) {
      canvas[i] = canvas[(ART - 1) * CW + i] = 4;
      canvas[i * CW] = canvas[i * CW + ART - 1] = 4;
    }
  }
  if (CFG.showText) {
    const text = await renderText(lines, TEXT_BOX);
    if (text) blit(canvas, text, TEXT_BOX.x, TEXT_BOX.y, TEXT_BOX.w, TEXT_BOX.h);
  }
  return canvas;
}

// Logical (upright) canvas -> native 1024x758 panel order.
function toPanel(canvas) {
  if (!PORTRAIT) return canvas;
  const out = new Uint8Array(W * H);
  const ccw = CFG.rotate === 270;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const cx = ccw ? CW - 1 - py : py;
      const cy = ccw ? px : CH - 1 - px;
      out[py * W + px] = canvas[cy * CW + cx];
    }
  }
  return out;
}

function pack(panel) {
  const out = Buffer.alloc(FRAME_BYTES);
  for (let i = 0, j = 0; j < FRAME_BYTES; i += 2, j++) out[j] = (panel[i] << 4) | panel[i + 1];
  return out;
}

async function toPreviewPng(canvas) {
  const grey = Buffer.alloc(canvas.length);
  for (let i = 0; i < canvas.length; i++) grey[i] = Math.round((canvas[i] * 255) / WHITE);
  return sharp(grey, { raw: { width: CW, height: CH, channels: 1 } }).png().toBuffer();
}

// ---------- published frame --------------------------------------------------

const blankCanvas = () => new Uint8Array(CW * CH).fill(WHITE);

let current = null; // { canvas, packed, etag, at }

// The ETag covers the image only. The frontlight level travels in a header on
// every response (200 and 304), so light changes never force an e-ink refresh.
function publish(canvas) {
  const packed = pack(toPanel(canvas));
  const etag = '"' + crypto.createHash('sha1').update(packed).digest('hex').slice(0, 20) + '"';
  current = { canvas, packed, etag, at: new Date().toISOString() };
  log(`frame ${etag}`);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- test mode ----------------------------------------------------------

if (process.argv[2] === '--test') {
  const [file, l1 = 'Track Title', l2 = 'Artist', l3 = 'Album'] = process.argv.slice(3);
  (async () => {
    const canvas = await composeFrame(file ? fs.readFileSync(file) : null, [l1, l2, l3]);
    fs.writeFileSync('preview.png', await toPreviewPng(canvas));
    fs.writeFileSync('frame.bin', pack(toPanel(canvas)));
    console.log('wrote preview.png and frame.bin');
  })().catch((e) => { console.error(e); process.exit(1); });
  return;
}

// ---------- Roon -----------------------------------------------------------------

const RoonApi = require('node-roon-api');
const { version: VERSION } = require('./package.json');
const REPO_URL = 'https://github.com/mbdmbd/roon-inkplate'; // shown in Roon's extension list
const RoonApiStatus = require('node-roon-api-status');
const RoonApiTransport = require('node-roon-api-transport');
const RoonApiImage = require('node-roon-api-image');

const zones = new Map();
let imageSvc = null;
let transport = null;
let corePaired = false;
let lastZoneId = null;
let displayActive = false; // true while a now-playing frame is up (light allowed on)

// Frontlight level and on/off, adjustable by touch and remembered in the working
// directory (the /data volume in Docker). Changing FRONTLIGHT resets the level.
const SETTINGS_FILE = 'display-settings.json';
const light = { level: CFG.frontlight, enabled: true };
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (saved.base === CFG.frontlight && Number.isInteger(saved.level)) light.level = Math.min(63, Math.max(0, saved.level));
  if (typeof saved.enabled === 'boolean') light.enabled = saved.enabled;
} catch (e) { /* first run, or an unreadable file: use the defaults */ }
function saveLight() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...light, base: CFG.frontlight }));
  } catch (e) { log('could not save display settings:', e.message); }
}
const effectiveLight = () => (displayActive && light.enabled ? light.level : 0);
let shownSig = 'idle';
let idleTimer = null;
let renderSeq = 0;

function getImage(key) {
  return new Promise((resolve, reject) => {
    if (!imageSvc) return reject(new Error('not paired'));
    imageSvc.get_image(key, { scale: 'fit', width: ART, height: ART, format: 'image/jpeg' }, (err, type, body) =>
      err ? reject(new Error(err)) : resolve(body));
  });
}

function selectZone() {
  const all = [...zones.values()];
  if (CFG.zoneName) return all.find((z) => z.display_name === CFG.zoneName) || null;
  return all.find((z) => z.state === 'playing') || all.find((z) => z.state === 'loading') || null;
}

async function showNowPlaying(sig, imageKey, lines) {
  const seq = ++renderSeq;
  shownSig = sig;
  let art = null;
  if (imageKey) {
    try { art = await getImage(imageKey); } catch (e) { log('image fetch failed:', e.message); }
  }
  try {
    const canvas = await composeFrame(art, lines);
    if (seq === renderSeq) {
      publish(canvas);
      displayActive = true;
    }
  } catch (e) {
    log('render failed:', e.message);
    if (seq === renderSeq) shownSig = ''; // retry on the next zone event
  }
}

function goIdle() {
  idleTimer = null;
  renderSeq++; // cancel any render in flight
  shownSig = 'idle';
  displayActive = false;
  if (CFG.idleMode !== 'keep' || !current) publish(blankCanvas());
  log('idle');
}

function evaluate() {
  const z = selectZone();
  const np = z && z.now_playing;
  const active = np && (z.state === 'playing' || z.state === 'loading');

  if (active) {
    lastZoneId = z.zone_id;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const t = np.three_line || {};
    const lines = [t.line1 || (np.one_line && np.one_line.line1) || '', t.line2 || '', t.line3 || ''];
    const sig = ['play', np.image_key || '', ...lines].join('|');
    if (sig !== shownSig) showNowPlaying(sig, np.image_key, lines);
  } else if (shownSig !== 'idle' && !idleTimer) {
    idleTimer = setTimeout(goIdle, CFG.graceSec * 1000);
  }
}

function onZones(cmd, msg) {
  if (cmd === 'Subscribed') {
    zones.clear();
    (msg.zones || []).forEach((z) => zones.set(z.zone_id, z));
  } else if (cmd === 'Changed') {
    // zones_seek_changed arrives every second during playback; ignore it.
    if (!msg.zones_added && !msg.zones_changed && !msg.zones_removed) return;
    (msg.zones_removed || []).forEach((id) => zones.delete(id));
    (msg.zones_added || []).forEach((z) => zones.set(z.zone_id, z));
    (msg.zones_changed || []).forEach((z) => zones.set(z.zone_id, z));
  } else if (cmd === 'Unsubscribed') {
    zones.clear();
  }
  evaluate();
}

const roon = new RoonApi({
  extension_id: 'roon-inkplate.bridge',
  display_name: 'Inkplate Now Playing',
  display_version: VERSION,
  publisher: 'roon-inkplate',
  email: 'n/a',
  website: REPO_URL,
  log_level: 'none',
  core_paired(core) {
    corePaired = true;
    imageSvc = core.services.RoonApiImage;
    transport = core.services.RoonApiTransport;
    status.set_status(`Paired with ${core.display_name}`, false);
    log('paired with', core.display_name);
    core.services.RoonApiTransport.subscribe_zones(onZones);
  },
  core_unpaired(core) {
    corePaired = false;
    imageSvc = null;
    transport = null;
    zones.clear();
    status.set_status('Waiting for Roon core', true);
    log('unpaired from', core.display_name);
    evaluate();
  },
});

const status = new RoonApiStatus(roon);
roon.init_services({ required_services: [RoonApiTransport, RoonApiImage], provided_services: [status] });
status.set_status('Starting', false);
publish(blankCanvas());

// Discovery uses UDP broadcast/multicast, which doesn't cross Docker's NAT on a
// Mac. Setting ROON_HOST connects straight to the core instead and works anywhere.
const ROON_HOST = CFG.roonHost;
const ROON_PORT = CFG.roonPort;
if (ROON_HOST) {
  const CONNECT_TIMEOUT_MS = CFG.connectTimeoutSec * 1000;
  const connect = () => {
    // A refused connection only fires onerror; a dropped one fires onclose.
    let retrying = false;
    let watchdog = null;
    const retry = () => {
      if (retrying) return;
      retrying = true;
      clearTimeout(watchdog);
      setTimeout(connect, 5000);
    };
    log(`connecting to Roon core at ${ROON_HOST}:${ROON_PORT}`);
    const moo = roon.ws_connect({ host: ROON_HOST, port: ROON_PORT, onclose: retry, onerror: retry });
    // Note any message from the core. Once it has answered, the connection is
    // alive even if pairing takes a while: Roon holds the registration open
    // until someone clicks Enable in Settings > Extensions, and dropping it then
    // would make the extension vanish from that list.
    let heardFromCore = false;
    const onmessage = moo.transport.onmessage;
    moo.transport.onmessage = (msg) => {
      heardFromCore = true;
      onmessage(msg);
    };
    // A core that is still starting up can accept the connection and then never
    // answer, which produces neither a close nor an error. Abandon and retry.
    watchdog = setTimeout(() => {
      if (corePaired || heardFromCore) return;
      log('no answer from Roon core, retrying');
      retry();
      try { moo.transport.close(); } catch (e) { /* already gone */ }
    }, CONNECT_TIMEOUT_MS);
  };
  connect();
} else {
  roon.start_discovery();
}

// ---------- touch controls ----------------------------------------------------

function controlZone() {
  if (CFG.zoneName) return [...zones.values()].find((z) => z.display_name === CFG.zoneName) || null;
  return zones.get(lastZoneId) || selectZone();
}

const roonCall = (fn) => new Promise((resolve, reject) => fn((err) => (err ? reject(new Error(err)) : resolve())));

async function transportControl(action) {
  const z = controlZone();
  if (!z || !transport) return { ok: false, error: 'no zone' };
  const allowed = {
    next: z.is_next_allowed,
    previous: z.is_previous_allowed,
    playpause: z.is_play_allowed || z.is_pause_allowed,
  }[action];
  if (!allowed) return { ok: false, error: `${action} not available right now` };
  await roonCall((cb) => transport.control(z, action, cb));
  return { ok: true, zone: z.display_name, action };
}

// Recently requested volumes, so quick repeated swipes build on each other
// instead of on a value Roon hasn't reported back yet.
const pendingVolume = new Map(); // output_id -> { value, until }

async function changeVolume(dir) {
  const z = controlZone();
  if (!z || !transport) return { ok: false, error: 'no zone' };
  const results = [];
  for (const o of z.outputs || []) {
    const v = o.volume;
    const name = o.display_name;
    if (!v) { results.push({ output: name, skipped: 'fixed volume' }); continue; }
    if (v.type === 'incremental') {
      // No reported level, so the maximum can't be enforced: allow down only.
      if (dir > 0) { results.push({ output: name, skipped: 'incremental control: up disabled' }); continue; }
      await roonCall((cb) => transport.change_volume(o, 'relative', -1, cb));
      results.push({ output: name, changed: 'down' });
      continue;
    }
    const p = pendingVolume.get(o.output_id);
    const cur = p && p.until > Date.now() ? p.value : v.value;
    if (!Number.isFinite(cur)) { results.push({ output: name, skipped: 'volume level unknown' }); continue; }
    const ceiling = Number.isFinite(v.max) ? Math.min(CFG.volumeMax, v.max) : CFG.volumeMax;
    const floor = Number.isFinite(v.min) ? v.min : -Infinity;
    let target;
    if (dir > 0) {
      if (cur >= ceiling) { results.push({ output: name, value: cur, skipped: `at limit (${ceiling})` }); continue; }
      target = Math.min(cur + CFG.volumeStep, ceiling);
    } else {
      if (cur <= floor) { results.push({ output: name, value: cur, skipped: 'at minimum' }); continue; }
      target = Math.min(cur, Math.max(cur - CFG.volumeStep, floor)); // never above the current level
    }
    await roonCall((cb) => transport.change_volume(o, 'absolute', target, cb));
    pendingVolume.set(o.output_id, { value: target, until: Date.now() + 3000 });
    results.push({ output: name, from: cur, to: target });
  }
  return { ok: results.some((r) => r.to !== undefined || r.changed), results };
}

const ACTIONS = new Set(['playpause', 'next', 'previous', 'vol_up', 'vol_down', 'light_toggle', 'light_up', 'light_down']);

async function handleControl(action) {
  switch (action) {
    case 'playpause':
    case 'next':
    case 'previous':
      return transportControl(action);
    case 'vol_up':
      return changeVolume(+1);
    case 'vol_down':
      return changeVolume(-1);
    case 'light_toggle':
      light.enabled = !light.enabled;
      if (light.enabled && light.level === 0) light.level = CFG.frontlight || CFG.lightStep;
      saveLight();
      return { ok: true, light };
    case 'light_up':
      light.level = Math.min(63, light.level + CFG.lightStep);
      light.enabled = true;
      saveLight();
      return { ok: true, light };
    case 'light_down':
      light.level = Math.max(0, light.level - CFG.lightStep);
      saveLight();
      return { ok: true, light };
    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}

// ---------- request guards ------------------------------------------------------

// DNS rebinding: a hostile web page can point its own domain at this bridge and
// then read it. Such requests carry that domain in Host, so only accept IP
// addresses, localhost, mDNS (.local) names and anything listed in ALLOWED_HOSTS.
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']')); // [IPv6]:port
  else h = h.replace(/:\d+$/, '');
  if (net.isIP(h)) return true;
  if (h === 'localhost' || h.endsWith('.local')) return true;
  return CFG.allowedHosts.includes(h);
}

// Cross-site request forgery: browsers always send Origin (and usually
// Sec-Fetch-Site) on a cross-site POST. The Inkplate and curl send neither, and
// the bridge has no web pages of its own, so any request carrying them is refused.
const fromBrowser = (req) => req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined;

function tokenOk(req) {
  if (!CONTROL_TOKEN) return true;
  const sent = crypto.createHash('sha256').update(String(req.headers['x-control-token'] || '')).digest();
  const want = crypto.createHash('sha256').update(CONTROL_TOKEN).digest();
  return crypto.timingSafeEqual(sent, want);
}

let previewCache = { etag: null, png: null };

// Exit promptly on docker stop / launchctl stop (node as PID 1 ignores SIGTERM otherwise).
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

// ---------- HTTP -----------------------------------------------------------------

http
  .createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(421);
      return res.end();
    }
    const readOnly = path === '/frame' || path === '/preview.png' || path === '/status';
    if (readOnly && req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    try {
      if (path === '/frame') {
        const meta = {
          ETag: current.etag,
          'X-Frontlight': String(effectiveLight()),
          'X-Layout': CFG.layout,
          'X-Rotate': String(CFG.rotate),
          'Cache-Control': 'no-cache',
        };
        if (req.headers['if-none-match'] === current.etag) {
          res.writeHead(304, meta);
          return res.end();
        }
        res.writeHead(200, { ...meta, 'Content-Type': 'application/octet-stream', 'Content-Length': current.packed.length });
        return res.end(current.packed);
      }
      if (path === '/control') {
        if (req.method !== 'POST') {
          res.writeHead(405, { Allow: 'POST' });
          return res.end();
        }
        req.resume();
        const json = { 'Content-Type': 'application/json; charset=utf-8' };
        if (fromBrowser(req)) {
          log('control: refused a browser request');
          res.writeHead(403, json);
          return res.end(JSON.stringify({ ok: false, error: 'browser requests are not accepted' }));
        }
        if (!tokenOk(req)) {
          log('control: refused, wrong or missing X-Control-Token');
          res.writeHead(401, json);
          return res.end(JSON.stringify({ ok: false, error: 'missing or wrong X-Control-Token' }));
        }
        const action = new URL(req.url, 'http://bridge').searchParams.get('action');
        if (!ACTIONS.has(action)) {
          log('control: unknown action', JSON.stringify(String(action).slice(0, 40)));
          res.writeHead(400, json);
          return res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
        }
        let result;
        try { result = await handleControl(action); } catch (e) { result = { ok: false, error: e.message }; }
        log(`control ${action}:`, JSON.stringify(result));
        res.writeHead(result.ok ? 200 : 409, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Frontlight': String(effectiveLight()),
        });
        return res.end(JSON.stringify(result));
      }
      if (path === '/preview.png') {
        if (previewCache.etag !== current.etag) previewCache = { etag: current.etag, png: await toPreviewPng(current.canvas) };
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        return res.end(previewCache.png);
      }
      if (path === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          zone: CFG.zoneName || '(first playing)',
          zones: [...zones.values()].map((z) => ({ name: z.display_name, state: z.state })),
          shown: shownSig, etag: current.etag, updated: current.at,
          light: { ...light, now: effectiveLight() },
          idlePending: Boolean(idleTimer), config: CFG,
        }, null, 2));
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      log('http error:', e.message);
      res.writeHead(500);
      res.end();
    }
  })
  .listen(CFG.port, () => log(`listening on :${CFG.port} (layout=${CFG.layout}, zone=${CFG.zoneName || 'any'})`));
