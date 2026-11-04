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
 *                      X-Layout, X-Rotate (so the Inkplate can map touches),
 *                      X-Screen and, when shown, X-Stations-Button (x,y,w,h)
 *   POST /control?action=playpause|next|previous|vol_up|vol_down|
 *                        light_toggle|light_up|light_down|stations
 *   POST /control?action=select&x=..&y=..  (stations screen; If-Match: frame ETag)
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
 *   node bridge.js --test-stations "Station" "Other=logo.png"  -> preview.png
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
  idleMode: oneOf('IDLE_MODE', 'blank', ['blank', 'keep', 'stations']), // white, last cover unlit, or station buttons
  stationsTimeoutSec: num('STATIONS_TIMEOUT_SEC', 20, { min: 5, max: 600 }), // station screen opened from the arrow
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

// Stations pinned to the first tiles of the stations screen, exactly as Roon
// names them in My Live Radio, separated by |. The remaining tiles show the
// most recently played stations.
const MAX_STATIONS = 6;
CFG.radioStations = env('RADIO_STATIONS', '').split('|').map((t) => t.trim()).filter(Boolean);
if (CFG.radioStations.length > MAX_STATIONS) configErrors.push(`RADIO_STATIONS lists ${CFG.radioStations.length} stations; at most ${MAX_STATIONS} fit`);
for (const t of CFG.radioStations) {
  if (t.length > 200 || /[\u0000-\u001f\u007f]/.test(t)) configErrors.push(`RADIO_STATIONS has an invalid name: "${t.slice(0, 40)}"`);
}
if (new Set(CFG.radioStations).size !== CFG.radioStations.length) configErrors.push('RADIO_STATIONS lists a station twice');
if (CFG.idleMode === 'stations' && !CFG.zoneName) configErrors.push('IDLE_MODE=stations needs ZONE_NAME (the zone the stations play in)');

// Optional shared secret for POST /control (sent by the Inkplate as X-Control-Token).
const CONTROL_TOKEN = env('CONTROL_TOKEN', '');
CFG.controlTokenSet = Boolean(CONTROL_TOKEN);

if (configErrors.length) {
  console.error('Invalid configuration:\n  ' + configErrors.join('\n  '));
  process.exit(1);
}
if (CFG.radioStations.length && CFG.idleMode !== 'stations') {
  console.warn('Warning: RADIO_STATIONS is ignored unless IDLE_MODE=stations.');
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

// Back-to-stations button on the now-playing screen: a 104 px (~13 mm) touch
// target in the bottom-left corner of the text area, drawn smaller and in grey.
const BACK = 104;
const BACK_PAD = 16;
const BACK_BOX = PORTRAIT
  ? { x: BACK_PAD, y: CH - BACK_PAD - BACK, w: BACK, h: BACK }
  : { x: ART + BACK_PAD, y: CH - BACK_PAD - BACK, w: BACK, h: BACK };
// With the button shown, the text keeps clear of it (and stays centred).
const TEXT_BOX_WITH_BACK = PORTRAIT
  ? { x: BACK_PAD + BACK, y: ART, w: CW - 2 * (BACK_PAD + BACK), h: CH - ART }
  : { x: ART, y: 0, w: CW - ART, h: CH - (BACK + BACK_PAD + 8) };

// Stations screen: a header line, then a grid of up to six tiles.
const ST = PORTRAIT
  ? { cols: 2, rows: 3, m: 32, gap: 24, top: 112, bottom: 32 }
  : { cols: 3, rows: 2, m: 32, gap: 24, top: 100, bottom: 32 };
const TILE_W = Math.floor((CW - 2 * ST.m - (ST.cols - 1) * ST.gap) / ST.cols);
const TILE_H = Math.floor((CH - ST.top - ST.bottom - (ST.rows - 1) * ST.gap) / ST.rows);
const LOGO = 172;
const tileRect = (i) => ({
  x: ST.m + (i % ST.cols) * (TILE_W + ST.gap),
  y: ST.top + Math.floor(i / ST.cols) * (TILE_H + ST.gap),
  w: TILE_W,
  h: TILE_H,
});

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

async function composeFrame(imageBuf, lines, { back = false } = {}) {
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
    const box = back ? TEXT_BOX_WITH_BACK : TEXT_BOX;
    const text = await renderText(lines, box);
    if (text) blit(canvas, text, box.x, box.y, box.w, box.h);
  }
  if (back) await drawSvg(canvas, backButtonSvg(), BACK_BOX.x, BACK_BOX.y, BACK, BACK);
  return canvas;
}

// ---------- stations screen and back button -----------------------------------

const greyOf = (level) => {
  const v = Math.round((level * 255) / WHITE).toString(16).padStart(2, '0');
  return `#${v}${v}${v}`;
};

// Rasterises an SVG of w x h onto the canvas at (x, y), rounding to the nearest
// level rather than dithering (flat greys stay flat) and keeping darker pixels.
async function drawSvg(canvas, svg, x, y, w, h) {
  const { data } = await sharp(Buffer.from(svg))
    .flatten({ background: '#ffffff' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const level = Math.round((data[yy * w + xx] / 255) * WHITE);
      const i = (y + yy) * CW + x + xx;
      if (level < canvas[i]) canvas[i] = level;
    }
  }
}

// A light grey chevron in a thin rounded square, centred in the touch target.
function backButtonSvg() {
  const D = 60;
  const o = (BACK - D) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BACK}" height="${BACK}">`
    + `<rect x="${o + 1}" y="${o + 1}" width="${D - 2}" height="${D - 2}" rx="14" fill="none" stroke="${greyOf(5)}" stroke-width="2"/>`
    + `<path d="M${o + 35} ${o + 18} L${o + 23} ${o + 30} L${o + 35} ${o + 42}" fill="none" stroke="${greyOf(3)}" `
    + 'stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

// Renders Pango markup, built for a scale, into an ink map (255 = ink) no larger
// than maxW x maxH, shrinking the text down to minScale if needed.
async function renderInk(markup, maxW, maxH, { align = 'centre', minScale = 0.5 } = {}) {
  let img = null;
  for (let scale = 1; scale >= minScale - 1e-9; scale -= 0.05) {
    const { data, info } = await sharp({
      text: { text: markup(scale), font: CFG.font, width: maxW, dpi: 72, wrap: 'word-char', align, spacing: 2 },
    })
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true });
    img = { data, width: info.width, height: info.height };
    if (info.height <= maxH && info.width <= maxW) break;
  }
  return img;
}

// Draws an ink map at (x, y), cropped to w x h; full ink becomes `level`.
function blitInk(canvas, ink, x, y, w, h, level = 0) {
  const tw = Math.min(ink.width, w);
  const th = Math.min(ink.height, h);
  for (let yy = 0; yy < th; yy++) {
    for (let xx = 0; xx < tw; xx++) {
      const a = ink.data[yy * ink.width + xx] / 255;
      if (!a) continue;
      const v = Math.round(WHITE - a * (WHITE - level));
      const i = (y + yy) * CW + x + xx;
      if (v < canvas[i]) canvas[i] = v;
    }
  }
}

const LOGO_RADIUS = 20;
function insideRounded(x, y, size, r) {
  const cx = Math.min(Math.max(x + 0.5, r), size - r);
  const cy = Math.min(Math.max(y + 0.5, r), size - r);
  return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
}

// Station logo: dithered like a cover (GAMMA applies), with rounded corners.
async function drawLogo(canvas, imageBuf, x, y) {
  const { data } = await sharp(imageBuf)
    .flatten({ background: '#ffffff' })
    .resize(LOGO, LOGO, { fit: 'cover' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const levels = ditherToLevels(data, LOGO, LOGO, CFG.gamma);
  for (let yy = 0; yy < LOGO; yy++) {
    for (let xx = 0; xx < LOGO; xx++) {
      if (insideRounded(xx, yy, LOGO, LOGO_RADIUS)) canvas[(y + yy) * CW + x + xx] = levels[yy * LOGO + xx];
    }
  }
}

// stations: [{ title, pinned, logo (image Buffer or null) }], up to six. A
// message (e.g. "Waiting for Roon") replaces the grid.
async function composeStations(stations, { message = '' } = {}) {
  const canvas = new Uint8Array(CW * CH).fill(WHITE);

  // Header: "Live Radio", and on the right the zone the stations play in.
  const head = await renderInk(() => `<span size="${38 * 1024}" weight="bold">Live Radio</span>`, Math.floor(CW / 2), 60, { align: 'left' });
  const headY = Math.max(0, Math.round((ST.top - 8 - head.height) / 2) + 4);
  blitInk(canvas, head, ST.m + 4, headY, Math.floor(CW / 2), 60);
  if (CFG.zoneName) {
    const zw = Math.floor(CW / 2) - ST.m;
    const zone = await renderInk((k) => `<span size="${Math.round(24 * k * 1024)}">${esc(cleanLine(CFG.zoneName))}</span>`, zw, 40, { align: 'left' });
    blitInk(canvas, zone, CW - ST.m - 4 - Math.min(zone.width, zw), headY + Math.max(0, head.height - zone.height - 4), zw, 40, 3);
  }

  if (message || !stations.length) {
    const gridH = CH - ST.top - ST.bottom;
    const ink = await renderInk(() => `<span size="${30 * 1024}">${esc(message || 'No stations')}</span>`, CW - 2 * ST.m, gridH);
    blitInk(canvas, ink, Math.floor((CW - ink.width) / 2), ST.top + Math.floor((gridH - ink.height) / 2), CW - 2 * ST.m, gridH, 2);
    return canvas;
  }

  // Tile outlines, the corner mark on pinned stations, and a plain square
  // where a station has no logo.
  const R = 28;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">`;
  stations.slice(0, MAX_STATIONS).forEach((st, i) => {
    const t = tileRect(i);
    const x0 = t.x + 1.5;
    const y0 = t.y + 1.5;
    const x1 = t.x + t.w - 1.5;
    svg += `<rect x="${x0}" y="${y0}" width="${t.w - 3}" height="${t.h - 3}" rx="${R}" fill="#ffffff" stroke="${greyOf(1)}" stroke-width="3"/>`;
    if (st.pinned) svg += `<path d="M${x1 - 46} ${y0} H${x1 - R} A${R} ${R} 0 0 1 ${x1} ${y0 + R} V${y0 + 46} Z" fill="${greyOf(1)}"/>`;
    if (!st.logo) {
      const lx = t.x + Math.floor((t.w - LOGO) / 2);
      svg += `<rect x="${lx}" y="${t.y + 22}" width="${LOGO}" height="${LOGO}" rx="${LOGO_RADIUS}" fill="${greyOf(6)}"/>`;
    }
  });
  svg += '</svg>';
  await drawSvg(canvas, svg, 0, 0, CW, CH);

  for (const [i, st] of stations.slice(0, MAX_STATIONS).entries()) {
    const t = tileRect(i);
    const lx = t.x + Math.floor((t.w - LOGO) / 2);
    const ly = t.y + 22;
    if (st.logo) {
      try { await drawLogo(canvas, st.logo, lx, ly); } catch (e) { log('logo render failed:', e.message); }
    }
    const top = ly + LOGO + 10;
    const lw = t.w - 36;
    const lh = t.y + t.h - 10 - top;
    const name = await renderInk((k) => `<span size="${Math.round(26 * k * 1024)}" weight="bold">${esc(cleanLine(st.title))}</span>`, lw, lh, { minScale: 0.6 });
    const nw = Math.min(name.width, lw);
    const nh = Math.min(name.height, lh);
    blitInk(canvas, name, t.x + Math.floor((t.w - nw) / 2), top + Math.floor((lh - nh) / 2), lw, lh);
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

let current = null; // { canvas, packed, etag, at, screen, hotspot, tiles }

// The ETag covers the image only. The frontlight level travels in a header on
// every response (200 and 304), so light changes never force an e-ink refresh.
// screen: nowplaying | stations | idle. hotspot: the back button, if drawn.
// tiles: where each station is, for hit-testing taps on the stations screen.
function publish(canvas, { screen = 'idle', hotspot = null, tiles = null } = {}) {
  const packed = pack(toPanel(canvas));
  const etag = '"' + crypto.createHash('sha1').update(packed).digest('hex').slice(0, 20) + '"';
  current = { canvas, packed, etag, at: new Date().toISOString(), screen, hotspot, tiles };
  log(`frame ${etag} (${screen})`);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- test mode ----------------------------------------------------------

if (process.argv[2] === '--test' || process.argv[2] === '--test-stations') {
  const args = process.argv.slice(3);
  // Stations test: each argument is a station name, optionally "Name=logo.png".
  // Names listed in RADIO_STATIONS are drawn pinned, first, as on the panel.
  const testStations = () => args.slice(0, MAX_STATIONS).map((a) => {
    const eq = a.lastIndexOf('=');
    const file = eq > 0 ? a.slice(eq + 1) : '';
    const named = file && fs.existsSync(file);
    const title = named ? a.slice(0, eq) : a;
    return { title, logo: named ? fs.readFileSync(file) : null, pinned: CFG.radioStations.includes(title) };
  }).sort((a, b) => (a.pinned && b.pinned ? CFG.radioStations.indexOf(a.title) - CFG.radioStations.indexOf(b.title) : b.pinned - a.pinned));
  (async () => {
    let canvas;
    if (process.argv[2] === '--test-stations') {
      const list = testStations();
      canvas = await composeStations(list, { message: list.length ? '' : 'No stations in My Live Radio' });
    } else {
      const [file, l1 = 'Track Title', l2 = 'Artist', l3 = 'Album'] = args;
      canvas = await composeFrame(file ? fs.readFileSync(file) : null, [l1, l2, l3], { back: CFG.idleMode === 'stations' });
    }
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
const RoonApiBrowse = require('node-roon-api-browse');

const zones = new Map();
let imageSvc = null;
let transport = null;
let browseSvc = null; // only with IDLE_MODE=stations, and only if the core offers it
let corePaired = false;
let lastZoneId = null;
let displayActive = false; // true while a now-playing frame is up (light allowed on)

// Remembered in the working directory (the /data volume in Docker): the
// touch-adjusted frontlight (reset when FRONTLIGHT changes), whether the panel's
// firmware can show the stations screen, and recently played stations.
const SETTINGS_FILE = 'display-settings.json';
const light = { level: CFG.frontlight, enabled: true };
let clientStations = false; // the panel's firmware sent "X-Features: stations"
let recentStations = [];    // station titles, most recent first
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (saved.base === CFG.frontlight && Number.isInteger(saved.level)) light.level = Math.min(63, Math.max(0, saved.level));
  if (typeof saved.enabled === 'boolean') light.enabled = saved.enabled;
  if (typeof saved.clientStations === 'boolean') clientStations = saved.clientStations;
  if (Array.isArray(saved.recentStations)) {
    recentStations = saved.recentStations.filter((t) => typeof t === 'string' && t.length <= 200).slice(0, 20);
  }
} catch (e) { /* first run, or an unreadable file: use the defaults */ }
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...light, base: CFG.frontlight, clientStations, recentStations }));
  } catch (e) { log('could not save display settings:', e.message); }
}
const effectiveLight = () => (displayActive && light.enabled ? light.level : 0);
let shownSig = 'idle';
let idleTimer = null;
let renderSeq = 0;

// The stations screen needs the setting and firmware that understands it. Older
// firmware keeps the plain idle screen and gets no back button.
const stationsEnabled = () => CFG.idleMode === 'stations' && clientStations;

function getImage(key, size = ART) {
  return new Promise((resolve, reject) => {
    if (!imageSvc) return reject(new Error('not paired'));
    imageSvc.get_image(key, { scale: 'fit', width: size, height: size, format: 'image/jpeg' }, (err, type, body) =>
      err ? reject(new Error(err)) : resolve(body));
  });
}

function selectZone() {
  const all = [...zones.values()];
  if (CFG.zoneName) return all.find((z) => z.display_name === CFG.zoneName) || null;
  return all.find((z) => z.state === 'playing') || all.find((z) => z.state === 'loading') || null;
}

// What a zone has loaded (playing or not), as the now-playing frame would show it.
function nowPlayingOf(z) {
  const np = z && z.now_playing;
  if (!np) return null;
  const t = np.three_line || {};
  const lines = [t.line1 || (np.one_line && np.one_line.line1) || '', t.line2 || '', t.line3 || ''];
  const back = stationsEnabled();
  return { sig: ['play', back ? 'back' : '', np.image_key || '', ...lines].join('|'), imageKey: np.image_key, lines, back };
}

async function showNowPlaying(n) {
  const seq = ++renderSeq;
  shownSig = n.sig;
  let art = null;
  if (n.imageKey) {
    try { art = await getImage(n.imageKey); } catch (e) { log('image fetch failed:', e.message); }
  }
  try {
    const canvas = await composeFrame(art, n.lines, { back: n.back });
    if (seq === renderSeq) {
      publish(canvas, { screen: 'nowplaying', hotspot: n.back ? BACK_BOX : null });
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
  log('idle');
  renderIdle();
}

function renderIdle() {
  if (stationsEnabled()) {
    showStations().catch((e) => {
      log('stations screen failed:', e.message);
      publish(blankCanvas());
    });
  } else if (CFG.idleMode !== 'keep' || !current) {
    publish(blankCanvas());
  }
}

// ---------- stations ---------------------------------------------------------------

let stationList = null;      // [{ title, imageKey }] from My Live Radio, in Roon's order
let stationsLoadedAt = 0;
let missingPinned = [];
let stationsUntil = 0;       // set while the stations screen opened from the back button is up
let stationsTimer = null;
let pendingStation = null;   // { title } after a tap, until Roon reports that station playing
let pendingTimer = null;
const logoCache = new Map(); // image_key -> image Buffer

// Browse calls share one session, and each load invalidates the item keys from
// the previous one, so they run strictly one at a time.
let browseChain = Promise.resolve();
function browseTask(fn) {
  const run = browseChain.then(fn, fn);
  browseChain = run.catch(() => {});
  return run;
}
function browseCall(method, opts) {
  return new Promise((resolve, reject) => {
    if (!browseSvc) return reject(new Error('Roon browse service not available'));
    browseSvc[method]({ multi_session_key: 'roon-inkplate', ...opts }, (err, body) => (err ? reject(new Error(err)) : resolve(body)));
  });
}

// My Live Radio. Each station is an "action" item at the top level: selecting
// it with a zone starts that station in the zone.
async function loadRadio(zoneId) {
  await browseCall('browse', { hierarchy: 'internet_radio', pop_all: true, zone_or_output_id: zoneId });
  const items = [];
  for (;;) {
    const r = await browseCall('load', { hierarchy: 'internet_radio', offset: items.length, count: 100 });
    items.push(...(r.items || []));
    if (!r.items || !r.items.length || items.length >= r.list.count || items.length >= 500) break;
  }
  stationList = items
    .filter((it) => it.hint === 'action' && typeof it.title === 'string' && it.title)
    .map((it) => ({ title: it.title, imageKey: it.image_key || null }));
  stationsLoadedAt = Date.now();
  const missing = CFG.radioStations.filter((t) => !stationList.some((s) => s.title === t));
  if (missing.join('|') !== missingPinned.join('|')) {
    missingPinned = missing;
    if (missing.length) log('RADIO_STATIONS not found in My Live Radio:', missing.join(', '));
  }
  return items;
}

function refreshStations() {
  const z = controlZone();
  return browseTask(() => loadRadio(z ? z.zone_id : undefined));
}

async function playStation(title) {
  const z = controlZone();
  if (!z) return { ok: false, error: 'no zone' };
  return browseTask(async () => {
    const items = await loadRadio(z.zone_id);
    const it = items.find((i) => i.title === title && i.hint === 'action' && i.item_key);
    if (!it) return { ok: false, error: 'station is no longer in My Live Radio' };
    const r = await browseCall('browse', { hierarchy: 'internet_radio', item_key: it.item_key, zone_or_output_id: z.zone_id });
    if (r && r.action === 'message' && r.is_error) return { ok: false, error: cleanLine(r.message || 'Roon refused') };
    noteRecent(title);
    return { ok: true, zone: z.display_name, station: title };
  });
}

function noteRecent(title) {
  if (recentStations[0] === title) return;
  recentStations = [title, ...recentStations.filter((t) => t !== title)].slice(0, 20);
  saveSettings();
}

// Stations started from the Roon app count as played too. Roon shows a live
// station's name as the first line, and live radio can't seek.
function noteStationPlaying(z) {
  if (!stationList || !z || z.state !== 'playing' || z.is_seek_allowed !== false) return;
  const t = z.now_playing && z.now_playing.three_line;
  const name = t && t.line1;
  if (name && stationList.some((s) => s.title === name)) noteRecent(name);
}

// Pinned stations first, in the order given. The other tiles go to the most
// recently played stations, shown in My Live Radio order so a tile only moves
// when a station joins or leaves the screen.
function chooseStations() {
  const pinned = CFG.radioStations.map((t) => stationList.find((s) => s.title === t)).filter(Boolean);
  const rank = (s) => {
    const i = recentStations.indexOf(s.title);
    return i < 0 ? recentStations.length : i;
  };
  const fill = stationList
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !CFG.radioStations.includes(s.title))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.idx - b.idx)
    .slice(0, MAX_STATIONS - pinned.length)
    .sort((a, b) => a.idx - b.idx)
    .map(({ s }) => s);
  return [...pinned.map((s) => ({ ...s, pinned: true })), ...fill.map((s) => ({ ...s, pinned: false }))];
}

async function getLogo(key) {
  if (logoCache.has(key)) return logoCache.get(key);
  const buf = await getImage(key, 256);
  logoCache.set(key, buf);
  if (logoCache.size > 40) logoCache.delete(logoCache.keys().next().value);
  return buf;
}

// Renders and publishes the stations screen; false if something newer won.
async function showStations() {
  const seq = ++renderSeq;
  if (browseSvc && (!stationList || Date.now() - stationsLoadedAt > 10 * 60 * 1000)) {
    try { await refreshStations(); } catch (e) { log('could not load My Live Radio:', e.message); }
  }
  let chosen = [];
  let message = '';
  if (!stationList) message = !corePaired ? 'Waiting for Roon' : browseSvc ? 'Could not load My Live Radio' : 'This Roon core does not offer browsing';
  else if (!stationList.length) message = 'No stations in My Live Radio';
  else chosen = chooseStations();
  for (const st of chosen) {
    st.logo = null;
    if (!st.imageKey) continue;
    try { st.logo = await getLogo(st.imageKey); } catch (e) { log('logo fetch failed:', e.message); }
  }
  const canvas = await composeStations(chosen, { message });
  if (seq !== renderSeq) return false;
  publish(canvas, { screen: 'stations', tiles: chosen.map((st, i) => ({ title: st.title, ...tileRect(i) })) });
  return true;
}

// The back button: show the stations screen for STATIONS_TIMEOUT_SEC, then
// return to what the zone has loaded.
function armStationsTimer() {
  clearTimeout(stationsTimer);
  stationsUntil = Date.now() + CFG.stationsTimeoutSec * 1000;
  stationsTimer = setTimeout(closeStations, CFG.stationsTimeoutSec * 1000);
}

async function openStations() {
  if (!stationsEnabled()) return { ok: false, error: 'stations screen not enabled' };
  if (current.screen === 'stations') {
    if (stationsUntil) armStationsTimer();
    return { ok: true, screen: 'stations' };
  }
  if (shownSig !== 'idle') {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    armStationsTimer();
  }
  return (await showStations()) ? { ok: true, screen: 'stations' } : { ok: false, error: 'screen changed' };
}

function closeStations() {
  clearTimeout(stationsTimer);
  stationsTimer = null;
  if (!stationsUntil) return;
  stationsUntil = 0;
  const n = nowPlayingOf(selectZone());
  if (n) showNowPlaying(n);
  else goIdle();
  evaluate();
}

async function selectAt(x, y, ifMatch) {
  if (!current || current.screen !== 'stations' || ifMatch !== current.etag) {
    return { ok: false, status: 412, error: 'the screen has changed' };
  }
  const tile = current.tiles.find((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h);
  if (!tile) {
    if (!stationsUntil) return { ok: false, error: 'no station there' };
    closeStations();
    return { ok: true, closed: true };
  }
  const result = await playStation(tile.title);
  if (result.ok) {
    // Keep this screen until Roon reports the new station, so the previous
    // track doesn't flash up in between; give up after 10 s.
    clearTimeout(stationsTimer);
    stationsTimer = null;
    clearTimeout(pendingTimer);
    pendingStation = { title: tile.title };
    pendingTimer = setTimeout(() => {
      pendingStation = null;
      if (stationsUntil) closeStations();
      else evaluate();
    }, 10000);
    evaluate();
  }
  return result;
}

function evaluate() {
  const z = selectZone();
  noteStationPlaying(z);
  const n = nowPlayingOf(z);
  const active = n && (z.state === 'playing' || z.state === 'loading');

  if (pendingStation) {
    if (!active || n.lines[0] !== pendingStation.title) return;
    clearTimeout(pendingTimer);
    pendingStation = null;
    clearTimeout(stationsTimer);
    stationsTimer = null;
    stationsUntil = 0;
  }
  if (stationsUntil) return; // the stations screen from the back button decides when to leave

  if (active) {
    lastZoneId = z.zone_id;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (n.sig !== shownSig) showNowPlaying(n);
  } else if (shownSig !== 'idle' && !idleTimer) {
    idleTimer = setTimeout(goIdle, CFG.graceSec * 1000);
  }
}

// Set from each /frame request the panel makes. Switching redraws the panel
// with or without the stations screen and back button.
function setClientStations(supported) {
  if (supported === clientStations) return;
  clientStations = supported;
  saveSettings();
  log(supported ? 'panel firmware supports the stations screen' : 'panel firmware has no stations screen');
  if (CFG.idleMode !== 'stations') return;
  clearTimeout(pendingTimer);
  pendingStation = null;
  clearTimeout(stationsTimer);
  stationsUntil = 0;
  if (shownSig === 'idle') {
    renderSeq++;
    renderIdle();
  } else {
    const n = nowPlayingOf(selectZone());
    if (n) showNowPlaying(n);
    evaluate();
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
    browseSvc = CFG.idleMode === 'stations' ? core.services.RoonApiBrowse || null : null;
    status.set_status(`Paired with ${core.display_name}`, false);
    log('paired with', core.display_name);
    core.services.RoonApiTransport.subscribe_zones(onZones);
    if (CFG.idleMode !== 'stations') return;
    if (!browseSvc) return log('this Roon core does not offer browsing; the stations screen will be empty');
    refreshStations()
      .then(() => {
        if (shownSig === 'idle' && stationsEnabled() && !stationsUntil) {
          renderSeq++;
          renderIdle();
        }
      })
      .catch((e) => log('could not load My Live Radio:', e.message));
  },
  core_unpaired(core) {
    corePaired = false;
    imageSvc = null;
    transport = null;
    browseSvc = null;
    zones.clear();
    status.set_status('Waiting for Roon core', true);
    log('unpaired from', core.display_name);
    evaluate();
  },
});

const status = new RoonApiStatus(roon);
roon.init_services({
  required_services: [RoonApiTransport, RoonApiImage],
  // Browsing (My Live Radio) is only requested for the stations screen.
  optional_services: CFG.idleMode === 'stations' ? [RoonApiBrowse] : [],
  provided_services: [status],
});
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

const ACTIONS = new Set(['playpause', 'next', 'previous', 'vol_up', 'vol_down', 'light_toggle', 'light_up', 'light_down', 'stations', 'select']);

async function handleControl(action, { x, y, ifMatch } = {}) {
  // While idle the light is off, so a change would be invisible and only show
  // up (as a surprise) when music next starts. Refuse it instead.
  if (action.startsWith('light_') && !displayActive) return { ok: false, error: 'display is idle' };
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
      saveSettings();
      return { ok: true, light };
    case 'light_up':
      light.level = Math.min(63, light.level + CFG.lightStep);
      light.enabled = true;
      saveSettings();
      return { ok: true, light };
    case 'light_down':
      light.level = Math.max(0, light.level - CFG.lightStep);
      saveSettings();
      return { ok: true, light };
    case 'stations':
      return openStations();
    case 'select':
      return selectAt(x, y, ifMatch);
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
        // The panel's firmware says whether it can use the stations screen.
        // Other clients (curl, scripts) don't change the setting.
        if (/\bstations\b/.test(String(req.headers['x-features'] || ''))) setClientStations(true);
        else if (req.headers['user-agent'] === 'ESP32HTTPClient') setClientStations(false);
        const meta = {
          ETag: current.etag,
          'X-Frontlight': String(effectiveLight()),
          'X-Layout': CFG.layout,
          'X-Rotate': String(CFG.rotate),
          'X-Screen': current.screen,
          'Cache-Control': 'no-cache',
        };
        if (current.hotspot) {
          const b = current.hotspot;
          meta['X-Stations-Button'] = `${b.x},${b.y},${b.w},${b.h}`;
        }
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
        const params = new URL(req.url, 'http://bridge').searchParams;
        const action = params.get('action');
        if (!ACTIONS.has(action)) {
          log('control: unknown action', JSON.stringify(String(action).slice(0, 40)));
          res.writeHead(400, json);
          return res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
        }
        // select: a tap on the stations screen, in upright canvas pixels, with the
        // ETag of the frame the panel is showing (If-Match).
        const opts = {};
        if (action === 'select') {
          const coord = (k, max) => (/^\d{1,5}$/.test(params.get(k) || '') && Number(params.get(k)) < max ? Number(params.get(k)) : null);
          opts.x = coord('x', CW);
          opts.y = coord('y', CH);
          opts.ifMatch = String(req.headers['if-match'] || '');
          if (opts.x === null || opts.y === null) {
            res.writeHead(400, json);
            return res.end(JSON.stringify({ ok: false, error: 'select needs x and y on the screen' }));
          }
        }
        let result;
        try { result = await handleControl(action, opts); } catch (e) { result = { ok: false, error: e.message }; }
        const code = result.status || (result.ok ? 200 : 409);
        delete result.status;
        log(`control ${action}:`, JSON.stringify(result));
        res.writeHead(code, {
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
          shown: shownSig, screen: current.screen, etag: current.etag, updated: current.at,
          light: { ...light, now: effectiveLight() },
          idlePending: Boolean(idleTimer),
          stations: CFG.idleMode === 'stations' ? {
            panelSupports: clientStations,
            browse: Boolean(browseSvc),
            myLiveRadio: stationList ? stationList.map((st) => st.title) : null,
            pinnedNotFound: missingPinned,
            recent: recentStations,
            onScreen: current.tiles ? current.tiles.map((t) => t.title) : null,
            backButtonUntil: stationsUntil ? new Date(stationsUntil).toISOString() : null,
          } : undefined,
          config: CFG,
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
