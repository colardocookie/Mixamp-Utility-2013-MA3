// EQ maths for the library and imports: 14-band fitter (port of ma3_harman_fit.py), AutoEq profile
// and target-file parsers, and a light AutoEq-style correction for imported targets. No device IO.
import * as core from './ma3-core.js';

export const GRID = core.PEAK_GRID;               // 241 log-spaced points, 20 Hz..20 kHz
export const FIT_RANGE_HZ = [20, 12000];
export const DEFAULT_SMOOTH = 0.003;

const COS = new Map();
function trig(f) {
  let t = COS.get(f);
  if (!t) { const w = 2 * Math.PI * f / core.FS; t = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)]; COS.set(f, t); }
  return t;
}
function sectionDb([b0, b1, b2, a1, a2], f) {
  const [c1, s1, c2, s2] = trig(f);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
export function bankDb(gains, f) {
  return core.customBands(gains).reduce((sum, [fc, g, q]) => sum + sectionDb(core.rbjPeak(fc, g, q), f), 0);
}

function solve(a, b) {
  const n = b.length, m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const k = m[r][c] / m[c][c]; for (let j = c; j <= n; j++) m[r][j] -= k * m[c][j]; }
  }
  return m.map((row, i) => row[n] / row[i]);
}

// Damped Gauss-Newton on 14 gains plus a free level offset; smooth penalises neighbour differences.
export function fitBands(points, { smooth = DEFAULT_SMOOTH, ridge = 0, iterations = 60 } = {}) {
  const pts = points.filter(([f]) => f >= FIT_RANGE_HZ[0] && f <= FIT_RANGE_HZ[1]);
  const [lo, hi] = core.BAND_GAIN_RANGE, n = 15, npts = pts.length;
  const penalty = g => smooth * g.slice(1).reduce((s, v, i) => s + (g[i] - v) ** 2, 0) + ridge * g.reduce((s, v) => s + v * v, 0);
  const cost = (g, off) => pts.reduce((s, [f, t]) => s + (bankDb(g, f) + off - t) ** 2, 0) + npts * penalty(g);
  let gains = Array(14).fill(0), offset = 0, lam = 1;
  for (let it = 0; it < iterations; it++) {
    const base = pts.map(([f]) => bankDb(gains, f));
    const res = base.map((b, i) => b + offset - pts[i][1]);
    const c0 = res.reduce((s, r) => s + r * r, 0) + npts * penalty(gains);
    const cols = [];
    for (let k = 0; k < 14; k++) {
      const trial = gains.slice(); trial[k] += 0.05;
      cols.push(pts.map(([f], i) => (bankDb(trial, f) - base[i]) / 0.05));
    }
    cols.push(Array(npts).fill(1));
    const jtj = cols.map(a => cols.map(b => a.reduce((s, v, i) => s + v * b[i], 0)));
    const jtr = cols.map(a => a.reduce((s, v, i) => s + v * res[i], 0));
    for (let k = 0; k < 14; k++) { jtj[k][k] += npts * ridge; jtr[k] += npts * ridge * gains[k]; }
    for (let k = 0; k < 13; k++) {
      jtj[k][k] += npts * smooth; jtj[k + 1][k + 1] += npts * smooth; jtj[k][k + 1] -= npts * smooth; jtj[k + 1][k] -= npts * smooth;
      const d = gains[k] - gains[k + 1]; jtr[k] += npts * smooth * d; jtr[k + 1] -= npts * smooth * d;
    }
    let improved = false;
    while (lam <= 1e6) {
      const m = jtj.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lam) : v)));
      const step = solve(m, jtr.map(v => -v));
      const ng = gains.map((g, k) => Math.min(hi, Math.max(lo, g + step[k]))), no = offset + step[14];
      if (cost(ng, no) < c0) { gains = ng; offset = no; lam = Math.max(lam / 3, 1e-4); improved = true; break; }
      lam *= 4;
    }
    if (!improved) break;
  }
  const rounded = gains.map(g => Math.round(g * 10) / 10);
  const errs = pts.map(([f, t]) => bankDb(rounded, f) + offset - t);
  return {
    gains: rounded, levelOffsetDb: offset,
    rmsErrorDb: Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length),
    maxErrorDb: Math.max(...errs.map(Math.abs)),
  };
}

// ------------------------------------------------------------ curves

export function interpLog(points, f) {
  if (f <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [f1, v1] = points[i];
    if (f <= f1) { const [f0, v0] = points[i - 1]; return v0 + (v1 - v0) * Math.log(f / f0) / Math.log(f1 / f0); }
  }
  return points[points.length - 1][1];
}
export const onGrid = points => GRID.map(f => interpLog(points, f));

function shelfCoeffs(f0, g, q, high) {
  const A = 10 ** (g / 40), w = 2 * Math.PI * f0 / core.FS, c = Math.cos(w), al = Math.sin(w) / (2 * q), s = 2 * Math.sqrt(A) * al, k = high ? -1 : 1;
  const b0 = A * ((A + 1) - k * (A - 1) * c + s), b1 = 2 * k * A * ((A - 1) - k * (A + 1) * c), b2 = A * ((A + 1) - k * (A - 1) * c - s);
  const a0 = (A + 1) + k * (A - 1) * c + s, a1 = -2 * k * ((A - 1) + k * (A + 1) * c), a2 = (A + 1) + k * (A - 1) * c - s;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

// AutoEq profile formats: ParametricEQ.txt / FixedBandEQ.txt (EqualizerAPO filters), GraphicEQ.txt,
// or an AutoEq results CSV with an 'equalization' column. Returns the correction on GRID.
export function parseAutoEqProfile(text) {
  const t = text.replace(/^﻿/, '');
  const graphic = t.match(/GraphicEQ:\s*([^\n]+)/i);
  if (graphic) {
    const pts = graphic[1].split(';').map(s => s.trim().split(/\s+/).map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite) && p[0] > 0);
    if (pts.length < 2) throw new Error('GraphicEQ line has no usable points');
    return { kind: 'GraphicEQ', correction: onGrid(pts.sort((a, b) => a[0] - b[0])) };
  }
  if (/^\s*Filter/im.test(t)) {
    const sections = [];
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/Filter\s*\d*:\s*ON\s+(PK|PEQ|LSC|HSC|LS|HS|LSQ|HSQ)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+(-?[\d.]+)\s*dB(?:\s+Q\s+([\d.]+))?/i);
      if (!m) continue;
      const type = m[1].toUpperCase(), fc = +m[2], gain = +m[3], q = m[4] ? +m[4] : 0.707;
      if (fc <= 0 || fc >= core.FS / 2) continue;
      if (type === 'PK' || type === 'PEQ') sections.push(core.rbjPeak(fc, gain, q));
      else sections.push(shelfCoeffs(fc, gain, q, type.startsWith('H')));
    }
    if (!sections.length) throw new Error('No enabled filters found in the profile');
    return { kind: 'ParametricEQ', correction: GRID.map(f => sections.reduce((s, sec) => s + sectionDb(sec, f), 0)) };
  }
  const rows = t.trim().split(/\r?\n/);
  const header = rows[0].split(',').map(s => s.trim().toLowerCase());
  const fi = header.indexOf('frequency'), ei = header.indexOf('equalization');
  if (fi >= 0 && ei >= 0) {
    const pts = rows.slice(1).map(r => r.split(',')).map(c => [+c[fi], +c[ei]]).filter(p => p.every(Number.isFinite) && p[0] > 0);
    return { kind: 'AutoEq results CSV', correction: onGrid(pts) };
  }
  throw new Error('Not an AutoEq profile: expected ParametricEQ, FixedBandEQ, GraphicEQ or a results CSV with an equalization column');
}

// Target curves: CSV (frequency,raw|target|...), or REW / squig.link text (frequency and dB per line).
export function parseTargetFile(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() && !/^[*#]/.test(l.trim()));
  let pts;
  const header = lines[0].split(',').map(s => s.trim().toLowerCase());
  if (header.includes('frequency')) {
    const fi = header.indexOf('frequency'), vi = ['raw', 'target', 'smoothed'].map(k => header.indexOf(k)).find(i => i >= 0) ?? 1;
    pts = lines.slice(1).map(l => l.split(',')).map(c => [+c[fi], +c[vi]]);
  } else {
    pts = lines.map(l => l.trim().split(/[\s,;]+/).map(Number)).map(c => [c[0], c[1]]);
  }
  pts = pts.filter(p => p.every(Number.isFinite) && p[0] > 0).sort((a, b) => a[0] - b[0]);
  if (pts.length < 10) throw new Error('Could not read a frequency response from the file');
  if (pts[0][0] > 50 || pts[pts.length - 1][0] < 10000) throw new Error(`The curve only covers ${Math.round(pts[0][0])} Hz to ${Math.round(pts[pts.length - 1][0])} Hz; a target must span at least 50 Hz to 10 kHz`);
  return pts;
}

// A named column from a CSV with a 'frequency' header, or null if the file has no such column.
// AutoEq results CSVs carry 'target': the Harman 2018 curve on that measurement's rig, as AutoEq used it.
export function parseCsvColumn(text, column) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const header = lines[0].split(',').map(s => s.trim().toLowerCase());
  const fi = header.indexOf('frequency'), ci = header.indexOf(column);
  if (fi < 0 || ci < 0) return null;
  const pts = lines.slice(1).map(l => l.split(',')).map(c => [+c[fi], +c[ci]]).filter(p => p.every(Number.isFinite) && p[0] > 0);
  return pts.length >= 10 ? pts.sort((a, b) => a[0] - b[0]) : null;
}

// AutoEq correction (port of autoeq 4.x FrequencyResponse.process with min_mean_error, max_gain 6 dB):
// AutoEq's 1.01-step grid, centring at 1 kHz, Savitzky-Golay smoothing (1/12 octave, 2 octaves above
// a 6-8 kHz sigmoid crossover), the 18 dB/octave slope limiter with its protected-dip zones, boost cap,
// then 1/5-octave smoothing. test/eq.test.js checks it against the real engine on every bundled target.
export const AUTOEQ_GRID = (() => { const g = []; for (let f = 20; f <= 20000; f *= 1.01) g.push(f); return g; })();
const windowSize = octaves => { let n = Math.round(Math.log(2 ** octaves) / Math.log(1.01)); return n % 2 ? n : n + 1; };
function polyfit2(xs, ys) {                       // least-squares quadratic, returns [c0, c1, c2]
  const s = [0, 0, 0, 0, 0], r = [0, 0, 0];
  xs.forEach((x, i) => { let p = 1; for (let k = 0; k < 5; k++) { s[k] += p; if (k < 3) r[k] += p * ys[i]; p *= x; } });
  return solve([[s[0], s[1], s[2]], [s[1], s[2], s[3]], [s[2], s[3], s[4]]], r);
}
function savgol(y, n) {                           // scipy.signal.savgol_filter(y, n, 2), mode='interp'
  const h = (n - 1) / 2, out = new Array(y.length);
  const xs = Array.from({ length: n }, (_, i) => i - h);
  const coeffs = xs.map(x0 => { const e = xs.map(x => (x === x0 ? 1 : 0)); const p = polyfit2(xs, e); return p[0]; });
  for (let i = h; i < y.length - h; i++) { let v = 0; for (let k = 0; k < n; k++) v += coeffs[k] * y[i - h + k]; out[i] = v; }
  const edge = (from, idxs) => { const xsE = Array.from({ length: n }, (_, i) => i); const p = polyfit2(xsE, xsE.map(i => y[from + i])); idxs.forEach(i => { const x = i - from; out[i] = p[0] + p[1] * x + p[2] * x * x; }); };
  edge(0, Array.from({ length: h }, (_, i) => i));
  edge(y.length - n, Array.from({ length: h }, (_, i) => y.length - h + i));
  return out;
}
const expit = x => 1 / (1 + Math.exp(-x));
function trebleWeight(f, lo = 6000, hi = 8000) {
  const fc = Math.sqrt(hi / lo) * lo, half = Math.log10(hi) - Math.log10(fc);
  return expit((Math.log10(f) - Math.log10(fc)) / (half / 4));
}
function smoothen(y, normalOct, trebleOct) {
  const a = savgol(y, windowSize(normalOct)), b = savgol(y, windowSize(trebleOct));
  return y.map((_, i) => { const k = trebleWeight(AUTOEQ_GRID[i]); return a[i] * (1 - k) + b[i] * k; });
}
// scipy.signal.find_peaks(y, prominence=minProminence): local maxima (plateaus at their middle).
function findPeaks(y, minProminence = 1) {
  const peaks = [];
  for (let i = 1; i < y.length - 1; i++) {
    if (!(y[i] > y[i - 1])) continue;
    let j = i;
    while (j + 1 < y.length - 1 && y[j + 1] === y[i]) j++;
    if (y[j + 1] < y[i]) peaks.push(Math.floor((i + j) / 2));
    i = j;
  }
  return peaks.filter(p => {
    let l = p, lmin = y[p]; while (l > 0 && y[l - 1] <= y[p]) { l--; lmin = Math.min(lmin, y[l]); }
    let r = p, rmin = y[p]; while (r < y.length - 1 && y[r + 1] <= y[p]) { r++; rmin = Math.min(rmin, y[r]); }
    return y[p] - Math.max(lmin, rmin) >= minProminence;
  });
}
function protectionMask(y, peaks, dips) {
  let dipInds = dips.slice(), dipLevels;
  if (peaks.length && (!dips.length || peaks[peaks.length - 1] > dips[dips.length - 1])) {
    const from = peaks[peaks.length - 1];
    let m = from; for (let i = from; i < y.length; i++) if (y[i] < y[m]) m = i;
    dipInds.push(m); dipLevels = dipInds.map(i => y[i]);
  } else {
    dipInds.push(y.length - 1); dipLevels = dipInds.map(i => y[i]); dipLevels[dipLevels.length - 1] = Math.min(...y);
  }
  const mask = new Array(y.length).fill(false);
  if (dipInds.length < 3) return mask;
  for (let k = 1; k < dipInds.length - 1; k++) {
    const d = dipInds[k], left = dipLevels[k - 1], right = dipLevels[k + 1];
    let li = -1; for (let i = 0; i < d; i++) if (y[i] >= left) li = i;
    let ri = -1; for (let i = d; i < y.length; i++) if (y[i] >= right) { ri = i; break; }
    if (li < 0 || ri < 0) continue;
    for (let i = li + 1; i <= ri - 1; i++) mask[i] = true;
  }
  return mask;
}
function rtlStart(y, peaks, dips) {
  if (peaks.length && (!dips.length || peaks[peaks.length - 1] > dips[dips.length - 1])) {
    const p = peaks[peaks.length - 1], level = dips.length ? y[dips[dips.length - 1]] : Math.max(y[0], y[y.length - 1]);
    for (let i = p; i < y.length; i++) if (y[i] <= level) return i;
    return y.length - 1;
  }
  return dips[dips.length - 1];
}
function limitedLtr(x, y, maxSlope, start, peaks, freeMask) {
  const lim = [], clipped = [], regions = [];
  for (let i = 0; i < x.length; i++) {
    if (i <= start) { lim.push(y[i]); clipped.push(false); continue; }
    const oct = Math.log2(x[i] / x[i - 1]), slope = (y[i] - lim[i - 1]) / oct;
    if (slope > maxSlope && !freeMask[i]) {
      if (!clipped[i - 1]) regions.push([i]);
      clipped.push(true); lim.push(lim[i - 1] + maxSlope * oct);
    } else {
      lim.push(y[i]);
      if (clipped[i - 1]) {
        const rs = regions[regions.length - 1][0];
        if (!peaks.some(p => p >= rs && p < i)) {
          for (let k = rs; k < i; k++) { lim[k] = y[k]; clipped[k] = false; }
          regions.pop();
        }
      }
      clipped.push(false);
    }
  }
  return lim;
}
function slopeLimit(x, y, maxSlope = 18) {
  const peaks = findPeaks(y), dips = findPeaks(y.map(v => -v));
  if (!peaks.length && !dips.length) return y.slice();
  const free = protectionMask(y, peaks, dips), start = rtlStart(y, peaks, dips), n = y.length;
  const ltr = limitedLtr(x, y, maxSlope, 0, peaks, free);
  const rtl = limitedLtr(x, y.slice().reverse(), maxSlope, n - start - 1, peaks.map(p => n - p - 1), free.slice().reverse()).reverse();
  return ltr.map((v, i) => Math.min(v, rtl[i]));
}
const onAutoEqGrid = pts => AUTOEQ_GRID.map(f => interpLog(pts, f));
export function autoEqCorrection(rawPts, targetPts, { maxGainDb = 6 } = {}) {
  const G = AUTOEQ_GRID, at1k = arr => interpLog(G.map((f, i) => [f, arr[i]]), 1000);
  let raw = onAutoEqGrid(rawPts), target = onAutoEqGrid(targetPts);
  const r0 = at1k(raw), t0 = at1k(target);
  raw = raw.map(v => v - r0); target = target.map(v => v - t0);
  let err = raw.map((v, i) => v - target[i]);
  const band = G.map(f => f >= 100 && f <= 10000), mean = err.filter((_, i) => band[i]).reduce((s, v) => s + v, 0) / band.filter(Boolean).length;
  err = err.map(v => v - mean);
  const y = smoothen(err, 1 / 12, 2).map(v => -v);
  const eq = smoothen(slopeLimit(G, y).map(v => Math.min(maxGainDb, v)), 1 / 5, 1 / 5);
  return GRID.map(f => interpLog(G.map((g, i) => [g, eq[i]]), f));
}

// Moves a target from its native rig onto a measurement's rig: target - Harman on the target's rig + Harman on the
// measurement's rig (see tools/build_targets.py).
export function targetForHeadphone(targetPts, rigHarman, autoeqTarget) {
  const t = onGrid(targetPts);
  return t.map((v, i) => v - rigHarman[i] + autoeqTarget[i]);
}
