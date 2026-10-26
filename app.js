// MixAmp Utility UI. Device IO goes through ma3-device.js; everything else is offline.
import * as core from './ma3-core.js';
import { MixAmp, webHidAvailable } from './ma3-device.js';
import * as eq from './ma3-eq.js';

const $ = id => document.getElementById(id);
const fmt = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
const C_PREGAIN = -18.0205;

// ------------------------------------------------------------ log

const logLines = [];
function log(event, detail = {}) {
  const t = new Date();
  logLines.push({ time: t.toISOString(), event, ...detail });
  const li = document.createElement('li');
  const extra = Object.keys(detail).length ? ' ' + JSON.stringify(detail) : '';
  li.innerHTML = `<time>${t.toLocaleTimeString()}</time>`;
  li.append(event + extra);
  $('log').prepend(li);
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ------------------------------------------------------------ state

const amp = new MixAmp(log);
let status = null;                     // { presetIndex, dolbySelected, gateOn, codecEqOn }
let backup = null;                     // Uint8Array(0x1800), from the device or an opened file
let backupFromDevice = false;
let selected = 3;
const STARTS = {
  c: { label: 'Factory C', gains: core.STARTING_CURVES.curveC, pregain: C_PREGAIN, codecEq: 'factory' },
  b: { label: 'Factory B', gains: core.STARTING_CURVES.curveB, pregain: null, codecEq: 'factory' },
  a: { label: 'Factory A', gains: core.STARTING_CURVES.curveA, pregain: null, codecEq: 'factory' },
  flat: { label: 'Flat', gains: core.STARTING_CURVES.flat, pregain: -9.81, codecEq: 'off' },
};
const editors = Array.from({ length: core.NUM_SLOTS }, () => ({
  mode: 'custom', start: 'c', gains: STARTS.c.gains.slice(), pregain: C_PREGAIN, codecEq: 'factory', gate: 'off', gateCfg: null,
}));
const STORE = 'mixamp-utility-v1';
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved && Array.isArray(saved.editors) && saved.editors.length === core.NUM_SLOTS) saved.editors.forEach((e, i) => Object.assign(editors[i], e));
} catch (e) { /* storage unavailable */ }
const persist = () => { try { localStorage.setItem(STORE, JSON.stringify({ editors })); } catch (e) { /* ignore */ } };

// ------------------------------------------------------------ response model

const GRID = core.PEAK_GRID;
function shelf(f0, g, high) {
  const A = 10 ** (g / 40), w = 2 * Math.PI * f0 / core.FS, c = Math.cos(w), al = Math.sin(w) / Math.SQRT2, s = 2 * Math.sqrt(A) * al, k = high ? -1 : 1;
  const b0 = A * ((A + 1) - k * (A - 1) * c + s), b1 = 2 * k * A * ((A - 1) - k * (A + 1) * c), b2 = A * ((A + 1) - k * (A - 1) * c - s);
  const a0 = (A + 1) + k * (A - 1) * c + s, a1 = -2 * k * ((A - 1) + k * (A + 1) * c), a2 = (A + 1) + k * (A - 1) * c - s;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
// Approximate model of the codec's fixed AIF2 EQ: Q 0.5 peaks and shelves decoded from the factory ReTune coefficients.
const CODEC_SECTIONS = [shelf(69, 5, false), core.rbjPeak(345, -9, 0.5), core.rbjPeak(1000, 1, 0.5), core.rbjPeak(3500, 6, 0.5), shelf(10000, 3, true)];
const CODEC_DB = GRID.map(f => core.sectionsResponseDb(CODEC_SECTIONS, f));
function curveDb(akm, codecOn) {
  const secs = core.akmSections(akm), pg = core.akmPregainDb(akm);
  return GRID.map((f, i) => core.sectionsResponseDb(secs, f) + pg + (codecOn ? CODEC_DB[i] : 0));
}
const meanIn = (arr, lo, hi) => { let t = 0, n = 0; GRID.forEach((f, i) => { if (f >= lo && f <= hi) { t += arr[i]; n++; } }); return t / n; };
// Unquantised preview from band parameters (no firmware tables needed); within ~0.01 dB of the built image.
function bandsDb(bands, pregainDb, codecOn) {
  const secs = bands.map(([f, g, q]) => core.rbjPeak(f, g, q));
  return GRID.map((f, i) => core.sectionsResponseDb(secs, f) + pregainDb + (codecOn ? CODEC_DB[i] : 0));
}
const C_PLAYS = bandsDb(core.FACTORY_C_BANDS, core.FACTORY_C_PREGAIN_DB, true);
function matchedPregain(gains, codecEq) {
  const probe = bandsDb(core.customBands(gains), -30, codecEq === 'factory');
  return Math.round((-30 + meanIn(C_PLAYS, 100, 8000) - meanIn(probe, 100, 8000)) * 100) / 100;
}
// Offline preview of a custom curve, with the same loudness cap the image builder applies.
function previewCustom(e) {
  const raw = bandsDb(core.customBands(e.gains), 0, false);
  let pregain = e.pregain;
  const peak = Math.max(...raw) + pregain;
  if (peak > core.MAX_NET_GAIN_DB) pregain -= peak - core.MAX_NET_GAIN_DB + 0.05;
  return { pregain, peak: Math.max(...raw) + pregain, db: raw.map((v, i) => v + pregain + (e.codecEq === 'factory' ? CODEC_DB[i] : 0)) };
}
// Recovers band gains from a curve this utility built (same band grid); null for anything else.
function decodeCustomCurve(akm) {
  const secs = core.akmSections(akm), gains = [];
  for (let n = 0; n < 15; n++) {
    const [b0, , , a1, a2] = secs[n], x = (1 - a2) / (1 + a2), a0 = 1 + x, y = b0 * a0 - 1;
    const f = Math.acos(Math.max(-1, Math.min(1, -a1 * a0 / 2))) * core.FS / (2 * Math.PI);
    if (Math.abs(f - core.FACTORY_C_BANDS[n][0]) > 0.5 || !(x > 0 && y > 0)) return null;
    gains.push(Math.round(40 * Math.log10(Math.sqrt(y / x)) * 10) / 10);
  }
  return { gains: gains.slice(0, 14), pregain: Math.round(core.akmPregainDb(akm) * 100) / 100 };
}

// ------------------------------------------------------------ slot content

const slotNow = slot => backup ? backup.slice(core.slotCpuAddress(slot) - core.BACKUP_CPU_RANGE[0], core.slotCpuAddress(slot) - core.BACKUP_CPU_RANGE[0] + core.SLOT_SIZE) : null;

function buildImage(slot) {
  const e = editors[slot], opts = { gate: e.gate === 'off' ? 'off' : 'on', codecEq: e.codecEq, gateSettings: e.gate === 'off' || e.gate === 'factory' ? null : gateCfgFor(slot, e) };
  return e.mode === 'factory' ? core.factoryCurveImage(slot, opts) : core.customImage(slot, e.gains, e.pregain, opts);
}

// Preset selector on the MixAmp: four lights around the EQ button. Positions confirmed by live
// reads of the active preset on a 2013 MixAmp Pro. Slot 0 has no selector position.
const SELECTOR_SLOTS = [1, 2, 3, 4];
const POSITIONS = { 1: 'Top left', 2: 'Top right', 3: 'Bottom right', 4: 'Bottom left' };
const QUADRANT_START = { 1: 180, 2: 270, 3: 0, 4: 90 };   // degrees clockwise from 3 o'clock
const slotName = s => POSITIONS[s] ? `Slot ${s} · ${POSITIONS[s]}` : `Slot ${s} (no selector position)`;

function presetButtonSvg(lit, size) {
  const c = 50, r = 37, gap = 9;
  const pt = a => [c + r * Math.cos(a * Math.PI / 180), c + r * Math.sin(a * Math.PI / 180)].map(v => v.toFixed(2)).join(' ');
  const arcs = SELECTOR_SLOTS.map(s => {
    const a1 = QUADRANT_START[s] + gap, a2 = QUADRANT_START[s] + 90 - gap;
    return `<path class="led${s === lit ? ' lit' : ''}" d="M${pt(a1)} A${r} ${r} 0 0 1 ${pt(a2)}" fill="none" stroke-width="8" stroke-linecap="butt"/>`;
  }).join('');
  const bars = [[40, 44, 14], [47, 38, 20], [54, 41, 17]].map(([x, y, h]) => `<rect x="${x}" y="${y}" width="4.5" height="${h}" rx="1" fill="var(--knob-icon)"/>`).join('');
  const label = lit ? `MixAmp preset button with the ${POSITIONS[lit].toLowerCase()} light on` : 'MixAmp preset button';
  return `<svg class="presetbtn" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${label}">`
    + `<circle cx="50" cy="50" r="49" fill="var(--knob)"/><circle cx="50" cy="50" r="24" fill="none" stroke="var(--knob-icon)" stroke-opacity="0.35" stroke-width="1.5"/>`
    + arcs + bars + '</svg>';
}

function renderSlots() {
  const box = $('slots');
  box.innerHTML = '';
  for (const s of SELECTOR_SLOTS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'slot'; b.id = 'slot' + s; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(s === selected));
    const now = slotNow(s), d = now ? core.describeSlot(s, now) : null;
    const active = status && status.presetIndex === s ? '<span class="pill ok">Active</span>' : '';
    const detail = !d ? 'Contents are read when you connect' : d.state === 'custom' ? `${d.curve}, codec EQ ${d.codecEq}, ${gateSummary(d)}` : d.label;
    b.innerHTML = `${presetButtonSvg(s, 44)}<div class="slottext"><b>Slot ${s} ${active}</b><span class="pos">${POSITIONS[s]}</span><span>${detail}</span></div>`;
    b.addEventListener('click', () => { selected = s; renderAll(); });
    box.append(b);
  }
}

// ------------------------------------------------------------ mic noise gate

// The WM8994 gate is a downward expander: below the threshold the mic is turned down at the chosen
// ratio, by at most the max reduction. A gentle ratio with a partial reduction acts as noise reduction.
const GATE_PRESETS = {
  soft: { threshold: 16, ratio: 1, floor: 4 },     // -60 dB, 2:1, at most -12 dB
  strong: { threshold: 8, ratio: 3, floor: 0 },    // -48 dB, 8:1, at most -36 dB
};
// Factory values (from the factory tables when connected; the same numbers are used offline).
const FACTORY_GATE_FALLBACK = { 4: { threshold: 8, ratio: 2, floor: 0 } };
function factoryGateCfg(slot) {
  if (core.factoryTablesLoaded()) { const g = core.factoryGate(slot); return { threshold: g.threshold, ratio: g.ratio, floor: g.floor }; }
  return { ...(FACTORY_GATE_FALLBACK[slot] || { threshold: 12, ratio: 2, floor: 0 }) };
}
function gateCfgFor(slot, e) {
  if (e.gate === 'factory') return factoryGateCfg(slot);
  return e.gateCfg || GATE_PRESETS[e.gate] || factoryGateCfg(slot);
}
const gateText = c => `${core.gateThresholdDb(c.threshold)} dB, ${core.GATE_RATIOS[c.ratio]}:1, up to ${core.gateFloorDb(c.floor)} dB`;
function gateSummary(d) {
  if (d.gate !== 'on') return 'gate off';
  return `gate ${gateText(d.gateSettings)}`;
}
function gateStateFromSlot(slot, d) {
  if (d.gate !== 'on') return { gate: 'off', gateCfg: null };
  const c = { threshold: d.gateSettings.threshold, ratio: d.gateSettings.ratio, floor: d.gateSettings.floor };
  const f = factoryGateCfg(slot);
  const match = Object.entries(GATE_PRESETS).find(([, p]) => p.threshold === c.threshold && p.ratio === c.ratio && p.floor === c.floor);
  if (c.threshold === f.threshold && c.ratio === f.ratio && c.floor === f.floor) return { gate: 'factory', gateCfg: null };
  return match ? { gate: match[0], gateCfg: c } : { gate: 'custom', gateCfg: c };
}
function renderGate(e) {
  $('gate').value = e.gate;
  const c = gateCfgFor(selected, e);
  $('gateControls').hidden = e.gate === 'off';
  $('gThr').value = core.gateThresholdDb(c.threshold); $('gThrOut').textContent = `${core.gateThresholdDb(c.threshold).toFixed(1)} dB`;
  $('gRatio').value = String(c.ratio);
  $('gFloor').value = core.gateFloorDb(c.floor); $('gFloorOut').textContent = `${core.gateFloorDb(c.floor)} dB`;
  $('gateNote').textContent = e.gate === 'off'
    ? 'The mic is never turned down. Pick a mode to cut background noise between words.'
    : `Sound quieter than the threshold is turned down at ${core.GATE_RATIOS[c.ratio]}:1, by at most ${-core.gateFloorDb(c.floor)} dB. `
      + (e.gate === 'soft' ? 'A gentle ratio with a partial reduction lowers steady noise without chopping words. ' : '')
      + 'It is a level-based gate, not voice-aware noise suppression: noise louder than the threshold, or noise while you talk, still gets through.';
}

// ------------------------------------------------------------ editor

const bank = $('bank');
core.BAND_LABELS.forEach((label, i) => {
  const el = document.createElement('div');
  el.className = 'fader';
  el.innerHTML = `<span class="val" id="v${i}"></span><input type="range" id="b${i}" min="-12" max="12" step="0.1" aria-label="${label} Hz gain in dB"><span class="hz">${label}</span>`;
  bank.append(el);
  el.querySelector('input').addEventListener('input', ev => { const e = editors[selected]; e.gains[i] = Math.round(parseFloat(ev.target.value) * 10) / 10; e.start = null; renderEditor(); });
});
Object.entries(STARTS).forEach(([key, s]) => {
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'start-' + key; b.textContent = s.label;
  b.addEventListener('click', () => {
    const e = editors[selected];
    Object.assign(e, { mode: 'custom', start: key, gains: s.gains.slice(), codecEq: s.codecEq, ref: null });
    e.pregain = s.pregain === null ? matchedPregain(e.gains, e.codecEq) : s.pregain;
    renderEditor();
  });
  $('starts').append(b);
});
const loadBtn = document.createElement('button');
loadBtn.type = 'button'; loadBtn.id = 'loadFromSlot'; loadBtn.textContent = 'Load what\'s in this slot';
loadBtn.addEventListener('click', () => {
  const d = core.describeSlot(selected, slotNow(selected));
  const e = editors[selected];
  if (d.curve && d.curve.startsWith('factory curve')) Object.assign(e, { mode: 'factory', start: null });
  else { const c = decodeCustomCurve(d.akm); Object.assign(e, { mode: 'custom', start: null, gains: c.gains, pregain: c.pregain }); }
  Object.assign(e, { codecEq: d.codecEq, ...gateStateFromSlot(selected, d) });
  log('loaded slot contents into editor', { slot: selected });
  renderEditor();
});
$('starts').append(loadBtn);

document.querySelectorAll('input[name=curveMode]').forEach(r => r.addEventListener('change', () => { editors[selected].mode = r.value; renderEditor(); }));
$('codecEq').addEventListener('change', ev => { editors[selected].codecEq = ev.target.value; renderEditor(); });
$('gate').addEventListener('change', ev => {
  const e = editors[selected];
  e.gate = ev.target.value;
  if (GATE_PRESETS[e.gate]) e.gateCfg = { ...GATE_PRESETS[e.gate] };
  else if (e.gate === 'factory') e.gateCfg = factoryGateCfg(selected);
  else if (e.gate === 'custom' && !e.gateCfg) e.gateCfg = factoryGateCfg(selected);
  renderEditor();
});
const gateEdited = () => { const e = editors[selected]; e.gate = 'custom'; renderEditor(); };
$('gThr').addEventListener('input', ev => { const e = editors[selected]; e.gateCfg = { ...gateCfgFor(selected, e), threshold: Math.round((-36 - parseFloat(ev.target.value)) / 1.5) }; gateEdited(); });
$('gRatio').addEventListener('change', ev => { const e = editors[selected]; e.gateCfg = { ...gateCfgFor(selected, e), ratio: +ev.target.value }; gateEdited(); });
$('gFloor').addEventListener('input', ev => { const e = editors[selected]; e.gateCfg = { ...gateCfgFor(selected, e), floor: Math.round((parseFloat(ev.target.value) + 36) / 6) }; gateEdited(); });
$('level').addEventListener('input', ev => { editors[selected].pregain = Math.round(parseFloat(ev.target.value) * 10) / 10; editors[selected].start = null; renderEditor(); });
$('matchBtn').addEventListener('click', () => { const e = editors[selected]; e.pregain = matchedPregain(e.gains, e.codecEq); renderEditor(); });
$('confirmSlot').addEventListener('input', renderWriteState);

function drawChart(newDb, refDb, idealDb) {
  const W = 960, H = 300, L = 46, R = 12, T = 12, B = 30, dmin = -30, dmax = 0;
  const x = f => L + Math.log10(f / 20) / 3 * (W - L - R);
  const y = v => T + (dmax - Math.max(dmin, Math.min(dmax, v))) / (dmax - dmin) * (H - T - B);
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(GRID[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Frequency response of the new preset and the slot's current contents">`;
  for (let v = dmin; v <= dmax; v += 5) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" fill="none"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v ? '−' + Math.abs(v) : '0'}</text>`;
  [[20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'], [20000, '20k']]
    .forEach(([f, t]) => { s += `<line x1="${x(f)}" x2="${x(f)}" y1="${T}" y2="${H - B}" stroke="var(--grid)" fill="none"/><text x="${x(f)}" y="${H - 10}" text-anchor="middle">${t}</text>`; });
  s += `<text x="${L + 6}" y="${T + 12}">dBFS</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(core.MAX_NET_GAIN_DB)}" y2="${y(core.MAX_NET_GAIN_DB)}" stroke="var(--warn)" fill="none"/>`;
  if (refDb) s += `<path d="${path(refDb)}" fill="none" stroke="var(--ref)" stroke-width="2" stroke-dasharray="6 4"/>`;
  if (idealDb) s += `<path d="${path(idealDb)}" fill="none" stroke="var(--ok)" stroke-width="2" stroke-dasharray="2 3"/>`;
  s += `<path d="${path(newDb)}L${x(20000)},${y(dmin)}L${x(20)},${y(dmin)}Z" fill="var(--accent)" fill-opacity="0.1" stroke="none"/>`;
  s += `<path d="${path(newDb)}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>`;
  $('chart').innerHTML = s + '</svg>';
}

let current = null;   // { image, problems, sha }
async function renderEditor() {
  const e = editors[selected];
  $('edSlot').textContent = slotName(selected);
  $('edButton').innerHTML = presetButtonSvg(selected, 64);
  document.querySelectorAll('input[name=curveMode]').forEach(r => { r.checked = r.value === e.mode; });
  $('customBox').hidden = e.mode !== 'custom';
  $('codecEq').value = e.codecEq;
  renderGate(e);
  e.gains.forEach((g, i) => { $('v' + i).textContent = fmt(g); $('b' + i).value = g; });
  $('level').value = e.pregain; $('levelOut').textContent = fmt(e.pregain) + ' dB';
  Object.keys(STARTS).forEach(k => $('start-' + k).setAttribute('aria-pressed', String(e.start === k && e.mode === 'custom')));
  const now = slotNow(selected), d = now ? core.describeSlot(selected, now) : null;
  loadBtn.disabled = !d || d.state !== 'custom' || !(d.curve.startsWith('factory') || decodeCustomCurve(d.akm));
  $('edNow').textContent = d ? `Now: ${d.state === 'custom' ? `${d.curve}, codec EQ ${d.codecEq}, ${gateSummary(d)}` : d.label}` : 'Connect the MixAmp to compare with what is stored';
  persist();

  const checks = [];
  let image = null, problems = [];
  if (!core.factoryTablesLoaded()) {
    current = { image: null, problems: [], sha: null };
    if (e.mode === 'custom') {
      const p = previewCustom(e);
      if (Math.abs(p.pregain - e.pregain) > 0.01) checks.push(['info', `Level would be lowered to ${fmt(p.pregain)} dB to stay under the loudness limit`]);
      checks.push([p.peak <= core.MAX_NET_GAIN_DB + 0.01 ? 'ok' : 'bad', `Loudest point ${fmt(p.peak)} dB (limit ${core.MAX_NET_GAIN_DB} dB)`]);
      if (e.ref) checks.push(['info', `Fitted to 14 bands from ${escapeHtml(e.ref.label)}: ${e.ref.rms.toFixed(2)} dB RMS from the ideal correction (worst ${e.ref.max.toFixed(1)} dB)`]);
      let idealDb = null;
      if (e.ref) { const off = meanIn(p.db, 100, 8000) - meanIn(e.ref.correction, 100, 8000); idealDb = e.ref.correction.map(v => v + off); }
      $('idealLegend').hidden = !idealDb;
      drawChart(p.db, null, idealDb);
    } else $('chart').innerHTML = '';
    checks.push(['info', 'Preview only. Connect the MixAmp to build and check the preset: the utility reads the factory tables it needs from the MixAmp itself.']);
    $('checks').innerHTML = checks.map(([k, txt]) => `<div class="${k}">${k === 'ok' ? '✓' : k === 'bad' ? '✕' : '·'} ${txt}</div>`).join('');
    if (library) renderLibrary();
    renderSlots();
    renderWriteState();
    return;
  }
  try {
    image = buildImage(selected);
    problems = core.checkSlotImage(selected, image, { allowGateOn: e.gate !== 'off' });
  } catch (err) { problems = [err.message]; }
  if (image) {
    const loaded = core.simulateLoader(selected, image);
    const akm = loaded.akm, netPeak = core.maxNetGainDb(akm);
    if (e.mode === 'custom' && Math.abs(core.akmPregainDb(akm) - e.pregain) > 0.01) checks.push(['info', `Level lowered to ${fmt(core.akmPregainDb(akm))} dB to stay under the loudness limit`]);
    checks.push([loaded.source === 'custom' ? 'ok' : 'bad', `Startup simulation: the MixAmp ${loaded.source === 'custom' ? 'will load this preset' : 'would ignore it'}`]);
    checks.push([netPeak <= core.MAX_NET_GAIN_DB ? 'ok' : 'bad', `Loudest point ${fmt(netPeak)} dB (limit ${core.MAX_NET_GAIN_DB} dB)`]);
    if (now) {
      if (core.equalBytes(now, image)) checks.push(['info', 'Identical to what is in the slot now; nothing to write']);
      else {
        const was = new Map(core.simulateLoader(selected, now).codecPairs), changed = loaded.codecPairs.filter(([r, v]) => was.get(r) !== v).map(([r, v]) => `0x${r.toString(16)} → 0x${v.toString(16)}`);
        checks.push(['info', `Changes from the slot now: ${changed.length ? 'codec ' + changed.join(', ') + '; ' : ''}${core.equalBytes(core.simulateLoader(selected, now).akm, akm) ? 'EQ curve unchanged' : 'EQ curve changed'}`]);
      }
    }
    const sha = await core.sha256Hex(image);
    if (e.mode === 'custom' && e.ref) checks.push(['info', `Fitted to 14 bands from ${escapeHtml(e.ref.label)}: ${e.ref.rms.toFixed(2)} dB RMS from the ideal correction (worst ${e.ref.max.toFixed(1)} dB)`]);
    checks.push(['info', `Image SHA-256 <code>${sha}</code>`]);
    current = { image, problems, sha };
    const newDb = curveDb(akm, e.codecEq === 'factory');
    let idealDb = null;
    if (e.mode === 'custom' && e.ref) {
      const off = meanIn(newDb, 100, 8000) - meanIn(e.ref.correction, 100, 8000);
      idealDb = e.ref.correction.map(v => v + off);
    }
    $('idealLegend').hidden = !idealDb;
    drawChart(newDb, d ? curveDb(d.akm || core.factoryAkm(core.descriptor(selected)[1]), d.state === 'custom' ? d.codecEq === 'factory' : true) : null, idealDb);
    if (library) renderLibrary();
  } else current = { image: null, problems, sha: null };
  problems.forEach(p => checks.push(['bad', p]));
  if (!problems.length && image) checks.unshift(['ok', 'All safety checks pass']);
  $('checks').innerHTML = checks.map(([k, t]) => `<div class="${k}">${k === 'ok' ? '✓' : k === 'bad' ? '✕' : '·'} ${t}</div>`).join('');
  renderSlots();
  renderWriteState();
}

function renderWriteState() {
  const confirmed = $('confirmSlot').value.trim() === String(selected);
  const ready = amp.connected && amp.backup && !amp.busy;
  const nowSame = current && current.image && amp.backup && core.equalBytes(amp.slotFromBackup(selected), current.image);
  const occupied = amp.backup && !core.equalBytes(amp.slotFromBackup(selected), core.ERASED_SLOT);
  $('writeBtn').disabled = !(ready && confirmed && current && current.image && !current.problems.length && !nowSame);
  $('writeBtn').textContent = `${occupied ? 'Overwrite' : 'Write to'} slot ${selected}`;
  $('writeHint').textContent = !amp.connected ? '' : !amp.backup ? 'Reading the MixAmp…' : amp.busy ? 'Working…'
    : !current || !current.image || current.problems.length ? 'Fix the checks above to write.'
    : nowSame ? 'The slot already holds exactly this preset.'
    : !confirmed ? `Type ${selected} to confirm.` : '';
  $('restoreBtn').disabled = !(ready && confirmed && !core.equalBytes(amp.slotFromBackup(selected) || core.ERASED_SLOT, core.ERASED_SLOT));
  $('saveImageBtn').disabled = !(current && current.image);
  $('restoreBtn').textContent = `Restore slot ${selected} to factory`;
  $('verifyBtn').disabled = !(amp.connected && !amp.busy);
  $('writeNote').textContent = !amp.connected ? 'Connect the MixAmp to write. You can design and save image files without it.'
    : !amp.backup ? 'Reading the MixAmp; writing unlocks once its backup has been read.'
    : 'The MixAmp loads a slot when you select it. After writing, turn the selector to this slot (or away and back if it is already there), then press "Check on MixAmp".';
}

// ------------------------------------------------------------ device actions

function setResult(kind, text) { const r = $('result'); r.className = 'result ' + kind; r.textContent = text; }
function renderDevice() {
  $('connPill').textContent = amp.connected ? 'Connected' : 'Not connected';
  $('connPill').className = 'pill ' + (amp.connected ? 'ok' : '');
  $('connectBtn').textContent = amp.connected ? 'Disconnect' : 'Connect MixAmp';
  $('refreshBtn').disabled = !amp.connected || amp.busy;
  $('backupBtn').disabled = !amp.backup || amp.busy;
  $('fFirmware').textContent = amp.identity ? `${amp.identity.firmware} (model ${amp.identity.model.toString(16)})` : '–';
  $('fPreset').innerHTML = status ? `${presetButtonSvg(status.presetIndex, 28)}<span>${slotName(status.presetIndex)}</span>` : '–';
  $('fDolby').textContent = status ? (status.dolbySelected ? 'On' : 'Off') : '–';
  $('fGate').textContent = status ? (status.gateOn ? 'On' : 'Off') : '–';
  $('fCodec').textContent = status ? (status.codecEqOn ? 'On' : 'Off') : '–';
  $('fBackup').textContent = backup ? (backupFromDevice && amp.backup ? 'Read on connect (kept in this page only)' : 'Loaded from file (view only)') : amp.connected ? 'Reading…' : 'Read when you connect';
  renderWriteState();
}
function renderAll() { renderDevice(); renderEditor(); }

async function guarded(label, fn) {
  try { await fn(); } catch (err) { log(label + ' failed', { error: err.message }); setResult('bad', `${label} failed: ${err.message}`); }
  renderAll();
}

$('connectBtn').addEventListener('click', () => guarded('Connect', async () => {
  if (amp.connected) { await amp.disconnect(); status = null; backupFromDevice = false; return; }
  await amp.connect();
  setResult('', 'Connected. Reading the MixAmp…');
  status = await amp.readStatus();
  log('status', status);
  if (selected === 3 && SELECTOR_SLOTS.includes(status.presetIndex)) selected = status.presetIndex;
  backup = await amp.readBackup(); backupFromDevice = true;
  await amp.readFactoryTables();
  setResult('ok', 'Connected. The backup and the factory tables were read into this page; nothing was saved to your computer.');
}));
amp.onDisconnect = () => { status = null; backupFromDevice = false; renderAll(); setResult('warn', 'The MixAmp was unplugged. Reconnect it to continue.'); };
$('refreshBtn').addEventListener('click', () => guarded('Refresh', async () => { status = await amp.readStatus(); log('status', status); }));
$('backupBtn').addEventListener('click', () => {
  if (!amp.backup) return;
  download(`mixamp-backup-${stamp()}.bin`, amp.backup, 'application/octet-stream');
  log('backup file saved by user');
});
$('openBackup').addEventListener('change', ev => guarded('Open backup', async () => {
  const file = ev.target.files[0];
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length !== core.BACKUP_CPU_RANGE[1] - core.BACKUP_CPU_RANGE[0]) throw new Error('A MixAmp backup file is exactly 6144 bytes');
  backup = data; backupFromDevice = false;
  log('opened backup file', { name: file.name, sha256: await core.sha256Hex(data) });
  setResult('', 'Backup file loaded for viewing. Writing still needs a backup taken from the connected MixAmp.');
  ev.target.value = '';
}));

const EXPECTED_KEY = 'mixamp-utility-expected';
function rememberExpected(slot, image) {
  try { const m = JSON.parse(localStorage.getItem(EXPECTED_KEY) || '{}'); m[slot] = core.bytesToHex(image); localStorage.setItem(EXPECTED_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
}
async function writeImage(image, what) {
  setResult('', `Writing slot ${selected}… do not unplug the MixAmp.`);
  renderWriteState();
  await amp.writeSlot(selected, image, { allowGateOn: editors[selected].gate !== 'off' });
  backup = amp.backup;
  rememberExpected(selected, image);
  setResult('ok', `${what} written to ${slotName(selected).toLowerCase()} and verified. Turn the selector to this slot (or away and back), then press "Check on MixAmp".`);
}
$('writeBtn').addEventListener('click', () => guarded('Write', () => writeImage(current.image, 'Preset')));
$('restoreBtn').addEventListener('click', () => guarded('Restore', () => writeImage(core.ERASED_SLOT, 'Factory restore')));
$('verifyBtn').addEventListener('click', () => guarded('Check', async () => {
  let expected = null;
  try { const hex = JSON.parse(localStorage.getItem(EXPECTED_KEY) || '{}')[selected]; if (hex) expected = core.hexToBytes(hex); } catch (e) { /* ignore */ }
  status = await amp.readStatus();
  const slot = await amp.readSlot(selected);
  const lines = [];
  if (expected) lines.push(core.equalBytes(slot, expected) ? `Slot ${selected} holds the image you wrote.` : `Slot ${selected} does NOT match the image you wrote.`);
  const d = core.describeSlot(selected, slot);
  if (status.presetIndex === selected) {
    const want = d.state === 'custom' ? { gateOn: d.gate === 'on', codecEqOn: d.codecEq === 'factory' } : null;
    if (want) lines.push(status.gateOn === want.gateOn && status.codecEqOn === want.codecEqOn
      ? 'Live gate and codec EQ match the slot, so the MixAmp loaded it at power-up.'
      : 'Live gate or codec EQ do not match the slot. Turn the selector away and back so the MixAmp reloads it, then check again.');
    else lines.push('Slot is empty, so the factory preset is in use.');
  } else lines.push(`${slotName(selected)} is not selected on the MixAmp (${slotName(status.presetIndex).toLowerCase()} is). Turn the selector to it to check its live effect.`);
  log('check on MixAmp', { slot: selected, lines });
  setResult(lines.some(l => l.includes('NOT') || l.includes('do not')) ? 'warn' : 'ok', lines.join(' '));
}));
$('saveImageBtn').addEventListener('click', () => { if (current && current.image) download(`mixamp-slot${selected}-${current.sha.slice(0, 8)}.bin`, current.image, 'application/octet-stream'); });
$('saveLogBtn').addEventListener('click', () => download(`mixamp-log-${stamp()}.json`, JSON.stringify(logLines, null, 1), 'application/json'));

// ------------------------------------------------------------ target library, headphones and imports

const escapeHtml = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
let library = null;                 // public target curves + Harman reference per rig (data/targets.json)
let headphones = [];                // local profiles (data/local/headphones.json) + measurements imported in this browser
let importedTargets = [];           // targets imported in this browser (e.g. IEF)
let openCompany = null;
const HP_STORE = 'mixamp-utility-headphones-v1', TARGET_STORE = 'mixamp-utility-targets-v1', CURRENT_HP = 'mixamp-utility-current-hp';
const RIG_LABELS = {
  GRAS: 'GRAS (Harman, oratory1990, Crinacle GRAS 43AG-7)',
  'crinacle EARS + 711': 'Crinacle EARS + 711 (legacy)',
  'Rtings HMS II.3 (legacy)': 'Rtings HMS II.3',
  Innerfidelity: 'Innerfidelity',
  'Headphone.com Legacy': 'Headphone.com (legacy)',
};
const readStore = key => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; } };
const writeStore = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };
let currentHpId = (() => { try { return localStorage.getItem(CURRENT_HP); } catch (e) { return null; } })();
const currentHp = () => headphones.find(h => h.id === currentHpId) || null;
const allTargets = () => [...(library ? library.byId.values() : []), ...importedTargets];
const targetById = id => allTargets().find(t => t.id === id);
const companiesView = () => {
  const cs = library ? library.companies.map(c => ({ ...c })) : [];
  if (importedTargets.length) cs.push({ name: 'Imported', note: 'Targets imported in this browser.', targets: importedTargets });
  return cs;
};

// Correction for a headphone + target: the exact offline AutoEq result when a local profile has it,
// otherwise the browser port (within 0.07 dB of AutoEq on every bundled target).
function correctionFor(hp, t) {
  const pre = hp.presets && hp.presets[t.id];
  if (pre) return { gains: pre.gains, correction: pre.correction, rms: pre.rmsErrorDb, max: pre.maxErrorDb };
  const reference = hp.harmanReference || library.rigs[hp.rig];
  const moved = eq.targetForHeadphone(eq.GRID.map((f, i) => [f, t.curve[i]]), library.rigs[t.rig], reference);
  const correction = eq.autoEqCorrection(eq.GRID.map((f, i) => [f, hp.raw[i]]), eq.GRID.map((f, i) => [f, moved[i]]));
  const fit = eq.fitBands(eq.GRID.map((f, i) => [f, correction[i]]));
  return { gains: fit.gains, correction, rms: fit.rmsErrorDb, max: fit.maxErrorDb };
}

function applyCurve(label, correction, startKey, gains = null, stats = null) {
  const fit = gains ? { gains, rmsErrorDb: stats.rms, maxErrorDb: stats.max } : eq.fitBands(eq.GRID.map((f, i) => [f, correction[i]]));
  const e = editors[selected];
  Object.assign(e, { mode: 'custom', start: startKey, gains: fit.gains.slice(), codecEq: 'off', ref: { label, correction, rms: fit.rmsErrorDb, max: fit.maxErrorDb } });
  e.pregain = matchedPregain(e.gains, 'off');
  log('applied curve', { slot: selected, label, rmsErrorDb: +fit.rmsErrorDb.toFixed(2) });
  renderEditor();
  return fit;
}
function applyTarget(id) {
  const t = targetById(id), hp = currentHp();
  if (!t) return;
  if (!hp) { importResult('warn', 'Choose or import your headphone measurement first; a target is fitted to a specific headphone.'); $('importBox').open = true; return; }
  if (!t.convertible) return;
  const c = correctionFor(hp, t);
  applyCurve(`${t.name} for ${hp.name}`, c.correction, 'lib:' + id, c.gains, c);
}

function renderHeadphones() {
  const sel = $('headphone');
  sel.innerHTML = (headphones.length ? '' : '<option value="">No headphone yet</option>')
    + headphones.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}${h.local ? '' : ' (imported)'}</option>`).join('');
  if (currentHp()) sel.value = currentHpId;
  const hp = currentHp();
  $('libSub').textContent = !library ? $('libSub').textContent
    : hp ? `Each target is fitted for the ${hp.name} (${hp.source || RIG_LABELS[hp.rig] || hp.rig}) with AutoEq's method.`
      : "Import your headphone's frequency-response measurement (for example from AutoEq's measurements folder) to fit these targets to it.";
  $('removeHp').hidden = !hp || hp.local;
}

function renderLibrary() {
  renderHeadphones();
  const box = $('companies'), cs = companiesView();
  box.innerHTML = '';
  for (const c of cs) {
    const ok = c.targets.filter(t => t.convertible).length;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'company'; b.id = 'company-' + c.name.replace(/\W+/g, '-');
    b.setAttribute('role', 'listitem'); b.setAttribute('aria-expanded', String(openCompany === c.name));
    b.innerHTML = `<b>${escapeHtml(c.name)}</b><span>${c.targets.length ? `${c.targets.length} target${c.targets.length > 1 ? 's' : ''}${ok < c.targets.length ? `, ${c.targets.length - ok} need a 5128 measurement` : ''}` : 'Import only'}</span>`;
    b.addEventListener('click', () => { openCompany = openCompany === c.name ? null : c.name; renderLibrary(); });
    box.append(b);
  }
  const c = cs.find(x => x.name === openCompany);
  $('companyPick').hidden = !c;
  const e = editors[selected], current = e.mode === 'custom' && e.start && e.start.startsWith('lib:') ? e.start.slice(4) : '';
  const option = t => `<option value="${escapeHtml(t.id)}"${t.convertible ? '' : ' disabled'}>${escapeHtml(t.name)}${t.convertible ? '' : ' (needs a B&K 5128 measurement)'}</option>`;
  if (c) {
    $('companyName').textContent = c.name;
    const sel = $('companyTarget');
    sel.innerHTML = '<option value="">Choose…</option>' + c.targets.map(option).join('');
    sel.parentElement.hidden = !c.targets.length;
    sel.value = c.targets.some(t => t.id === current) ? current : '';
    const chosen = c.targets.find(t => t.id === sel.value);
    $('companyNote').innerHTML = c.targets.length ? escapeHtml((chosen && chosen.note) || c.note || '')
      : `${escapeHtml(c.note)} <button type="button" id="openImport">Import a target</button>`;
    const open = $('openImport');
    if (open) open.addEventListener('click', () => { $('importBox').open = true; $('targetFile').focus(); });
  }
  $('allTargets').innerHTML = '<option value="">Choose a target…</option>' + cs.filter(x => x.targets.length).map(x =>
    `<optgroup label="${escapeHtml(x.name)}">${x.targets.map(option).join('')}</optgroup>`).join('');
  $('allTargets').value = current;
}

async function loadLibrary() {
  try {
    const res = await fetch('data/targets.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    library = await res.json();
  } catch (err) {
    $('libSub').textContent = `The target library could not be loaded (${err.message}). Serve the folder over http, for example with python -m http.server.`;
    return;
  }
  library.byId = new Map(library.companies.flatMap(c => c.targets).map(t => [t.id, t]));
  const rigOptions = Object.keys(library.rigs).map(r => `<option value="${escapeHtml(r)}">${escapeHtml(RIG_LABELS[r] || r)}</option>`).join('');
  $('targetRig').innerHTML = rigOptions;
  $('measurementRig').innerHTML = rigOptions;
  headphones = readStore(HP_STORE);
  importedTargets = readStore(TARGET_STORE).map(t => ({ ...t, convertible: true }));
  try {                                     // optional local profiles, not part of the public repo
    const res = await fetch('data/local/headphones.json');
    if (res.ok) headphones = [...(await res.json()).headphones.map(h => ({ ...h, local: true })), ...headphones];
  } catch (e) { /* none */ }
  if (!currentHp() && headphones.length) currentHpId = headphones[0].id;
  renderLibrary();
}
$('allTargets').addEventListener('change', ev => { if (ev.target.value) applyTarget(ev.target.value); });
$('companyTarget').addEventListener('change', ev => { if (ev.target.value) applyTarget(ev.target.value); });
$('headphone').addEventListener('change', ev => {
  currentHpId = ev.target.value;
  try { localStorage.setItem(CURRENT_HP, currentHpId); } catch (e) { /* ignore */ }
  renderLibrary();
});
$('removeHp').addEventListener('click', () => {
  headphones = headphones.filter(h => h.id !== currentHpId);
  writeStore(HP_STORE, headphones.filter(h => !h.local));
  currentHpId = headphones[0] ? headphones[0].id : null;
  renderLibrary();
});

function importResult(kind, text) { const r = $('importResult'); r.className = 'result ' + kind; r.textContent = text; }
async function readCurveFile(input) {
  const f = input.files[0];
  input.value = '';
  if (!f) return null;
  const text = await f.text();
  return { name: f.name.replace(/\.(txt|csv)$/i, ''), points: eq.parseTargetFile(text), reference: eq.parseCsvColumn(text, 'target') };
}

$('profileFile').addEventListener('change', async ev => {
  const f = ev.target.files[0];
  if (!f) return;
  $('profileText').value = await f.text();
  if (!$('profileName').value) $('profileName').value = f.name.replace(/\.(txt|csv)$/i, '');
  ev.target.value = '';
});
$('profileApply').addEventListener('click', () => {
  try {
    const p = eq.parseAutoEqProfile($('profileText').value);
    const label = ($('profileName').value.trim() || 'Imported profile') + ` (${p.kind})`;
    const fit = applyCurve(label, p.correction, 'import');
    importResult('ok', `${label} fitted to 14 bands: ${fit.rmsErrorDb.toFixed(2)} dB RMS from the profile (worst ${fit.maxErrorDb.toFixed(1)} dB). Applied to slot ${selected}.`);
  } catch (err) { importResult('bad', err.message); }
});

let pendingMeasurement = null;
$('measurementFile').addEventListener('change', async ev => {
  try {
    pendingMeasurement = await readCurveFile(ev.target);
    if (pendingMeasurement && !$('measurementName').value) $('measurementName').value = pendingMeasurement.name;
    if (pendingMeasurement) importResult('', `Loaded ${pendingMeasurement.points.length} points${pendingMeasurement.reference ? ", plus the Harman reference AutoEq used for it, so fits match AutoEq exactly" : ''}. Pick the rig it was measured on, then press Add headphone.`);
  } catch (err) { pendingMeasurement = null; importResult('bad', err.message); }
  $('measurementApply').disabled = !pendingMeasurement || !library;
});
$('measurementApply').addEventListener('click', () => {
  const name = $('measurementName').value.trim() || pendingMeasurement.name, rig = $('measurementRig').value;
  const hp = { id: 'hp:' + Date.now(), name, rig, source: `imported, ${RIG_LABELS[rig] || rig}`, raw: eq.onGrid(pendingMeasurement.points).map(v => Math.round(v * 100) / 100) };
  if (pendingMeasurement.reference) hp.harmanReference = eq.onGrid(pendingMeasurement.reference).map(v => Math.round(v * 100) / 100);
  headphones.push(hp);
  writeStore(HP_STORE, headphones.filter(h => !h.local));
  currentHpId = hp.id;
  try { localStorage.setItem(CURRENT_HP, hp.id); } catch (e) { /* ignore */ }
  pendingMeasurement = null; $('measurementApply').disabled = true;
  importResult('ok', `Added ${name}. Pick a target in the library to fit it.`);
  renderLibrary();
});

let pendingTarget = null;
$('targetFile').addEventListener('change', async ev => {
  try {
    pendingTarget = await readCurveFile(ev.target);
    if (pendingTarget && !$('targetName').value) $('targetName').value = pendingTarget.name;
    if (pendingTarget) importResult('', `Loaded ${pendingTarget.points.length} points. Pick the rig it was measured on, then press Add target.`);
  } catch (err) { pendingTarget = null; importResult('bad', err.message); }
  $('targetApply').disabled = !pendingTarget || !library;
});
$('targetApply').addEventListener('click', () => {
  const name = $('targetName').value.trim() || pendingTarget.name, rig = $('targetRig').value;
  const t = { id: 'imp:' + Date.now(), name, rig, note: `Imported target (${RIG_LABELS[rig] || rig}).`, convertible: true, curve: eq.onGrid(pendingTarget.points).map(v => Math.round(v * 100) / 100) };
  importedTargets.push(t);
  writeStore(TARGET_STORE, importedTargets.map(({ convertible, ...rest }) => rest));
  pendingTarget = null; $('targetApply').disabled = true;
  openCompany = 'Imported';
  if (currentHp()) { applyTarget(t.id); importResult('ok', `Added ${name} to the library and fitted it for the ${currentHp().name}.`); }
  else { renderLibrary(); importResult('ok', `Added ${name} to the library. Add your headphone measurement to fit it.`); }
});

// ------------------------------------------------------------ start

if (!webHidAvailable()) { $('unsupported').hidden = false; $('connectBtn').disabled = true; }
log('utility loaded', { webHid: webHidAvailable() });
renderAll();
loadLibrary().then(() => renderEditor());
