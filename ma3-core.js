// MA3 core: slot image builder, loader simulator, safety policy and HID framing. No device IO.
// JavaScript port of ma3_preset_slot.py; webapp/test/core.test.js checks it byte-for-byte against
// golden images built by the Python research tools. Static basis: the firmware's preset loader and flash routines.
import { FACTORY_PARAMS as P } from './factory-params.js';

export const NUM_SLOTS = 5;
export const SLOT_SIZE = 0x400;
export const SLOT_CPU_BASE = 0x200400;
export const SLOT_FLASH_BASE = 0x800400;
export const BACKUP_CPU_RANGE = [0x200000, 0x201800];   // Sys sector + five slots
export const CHECKSUM_SPAN = [0x14, 0x3e8];
export const SLOT_HEADER = 0x14;
export const AKM_BYTES = 243;
export const FS = 48000;
export const Q22 = 1 << 22;
export const GATE_REG = 0x0440;
export const GATE_NG_ENA = 0x0100;
export const AIF2_EQ_REG = 0x0580;
export const AIF2_EQ_ENA = 0x0001;
export const MAX_NET_GAIN_DB = P.maxNetGainDb;
export const BAND_GAIN_RANGE = [-12, 12];
export const BAND_LABELS = ['20', '40', '63', '100', '160', '250', '400', '630', '1k', '1.6k', '2.5k', '4k', '6.5k', '10k'];
export const OP = { VERSION: 0, READ_CODEC: 7, FLASH_FROM_USB: 9, READ_MEM: 24, READ_SYS: 27 };
export const EXPECTED_VERSION = { firmware: 3374, model: 0x1005 };
export const READ_PIECE = 32;                           // 18 + 32 + 1 = 51-byte reply, one HID report
export const CODEC_READ_ALLOWLIST = [0x0440, 0x0444, 0x0480, 0x0481, 0x0501, 0x0580, 0x0581];
export const ERASED_SLOT = new Uint8Array(SLOT_SIZE).fill(0xff);

// ------------------------------------------------------------ bytes

export const hexToBytes = h => Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
export const bytesToHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export async function sha256Hex(bytes) {
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
function putU32(b, o, v) { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
function putU16(b, o, v) { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; }

// ------------------------------------------------------------ factory data

// The factory tables are not shipped: they are read from the connected MixAmp's program memory
// (P.tables gives the addresses) and accepted only if every array matches its SHA-256 fingerprint.
let TABLES = null;
export const FACTORY_TABLE_RANGES = [P.tables.codec, P.tables.akm].map(t => ({ address: t.address, length: t.length }));
export async function setFactoryTables(codecBytes, akmBytes) {
  const { codec, akm } = P.tables;
  if (codecBytes.length !== codec.length || akmBytes.length !== akm.length) throw new Error('Factory tables have the wrong size');
  const akmArrays = {}, codecArrays = {};
  for (const [i, va] of akm.arrays.entries()) akmArrays[va] = akmBytes.slice(i * akm.bytes, (i + 1) * akm.bytes);
  for (const [i, va] of codec.arrays.entries()) {
    const raw = codecBytes.slice(i * codec.pairs * 4, (i + 1) * codec.pairs * 4);
    codecArrays[va] = { raw, pairs: Array.from({ length: codec.pairs }, (_, k) => [u16(raw, 4 * k), u16(raw, 4 * k + 2)]) };
  }
  for (const [va, bytes] of [...Object.entries(akmArrays), ...Object.entries(codecArrays).map(([v, c]) => [v, c.raw])]) {
    if (await sha256Hex(bytes) !== P.tableSha256[va]) throw new Error(`Factory table ${va} does not match the expected firmware; this MixAmp is not supported`);
  }
  TABLES = { akmArrays, codecArrays };
}
export const factoryTablesLoaded = () => TABLES !== null;
export const clearFactoryTables = () => { TABLES = null; };
function tables() {
  if (!TABLES) throw new Error('Connect the MixAmp so the utility can read its factory tables');
  return TABLES;
}
export const factoryAkm = va => tables().akmArrays[va].slice();
export const factoryCodecPairs = va => tables().codecArrays[va].pairs.map(p => p.slice());
export const descriptor = slot => P.descriptors[String(slot)];
export const FACTORY_C_BANDS = P.factoryCBands;
export const FACTORY_C_PREGAIN_DB = P.factoryCPregainDb;
export const STARTING_CURVES = P.startingCurves;

// ------------------------------------------------------------ checksum

export function adler32(bytes) {
  let a = 1, b = 0;
  for (const x of bytes) { a = (a + x) % 0xfff1; b = (b + a) % 0xfff1; }
  return ((b << 16) | a) >>> 0;
}

// ------------------------------------------------------------ AKM coefficients (Q2.22)

const s24 = w => (w & 0x800000 ? w - 0x1000000 : w);
function roundHalfEven(v) {          // matches Python's round()
  const f = Math.floor(v), d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
export function toQ22(x) {
  const v = roundHalfEven(x * Q22);
  if (v < -(1 << 23) || v >= (1 << 23)) throw new Error(`Coefficient ${x} outside Q2.22 range`);
  return v & 0xffffff;
}
export function rbjPeak(f0, gainDb, q, fs = FS) {
  const A = 10 ** (gainDb / 40), w = 2 * Math.PI * f0 / fs, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha / A;
  return [(1 + alpha * A) / a0, -2 * Math.cos(w) / a0, (1 - alpha * A) / a0, -2 * Math.cos(w) / a0, (1 - alpha / A) / a0];
}
export function akmWords(akm) {
  if (akm.length !== AKM_BYTES) throw new Error('AKM preset must be 243 bytes');
  const w = [];
  for (let i = 0; i < AKM_BYTES; i += 3) w.push((akm[i] << 16) | (akm[i + 1] << 8) | akm[i + 2]);
  return w;
}
export function akmSections(akm) {
  const w = akmWords(akm).map(x => s24(x) / Q22), out = [];
  for (let s = 6; s < 81; s += 5) {
    const [b2, b1, na2, na1, b0] = w.slice(s, s + 5);
    out.push([b0, b1, b2, -na1, -na2]);
  }
  return out;
}
export const akmPregainDb = akm => 20 * Math.log10(s24(akmWords(akm)[0]) / Q22);

export function buildAkm(bands, pregainDb, headerFrom) {
  if (bands.length !== 15) throw new Error('Exactly 15 sections are required');
  const words = akmWords(headerFrom);
  words[0] = toQ22(10 ** (pregainDb / 20));
  bands.forEach(([f0, g, q], n) => {
    const [b0, b1, b2, a1, a2] = rbjPeak(f0, g, q);
    words.splice(6 + 5 * n, 5, toQ22(b2), toQ22(b1), toQ22(-a2), toQ22(-a1), toQ22(b0));
  });
  const out = new Uint8Array(AKM_BYTES);
  words.forEach((w, i) => { out[3 * i] = w >>> 16; out[3 * i + 1] = (w >>> 8) & 255; out[3 * i + 2] = w & 255; });
  return out;
}

// Complex arithmetic in the same order as the Python cmath version.
function cmul(a, b) { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]; }
function cdiv(a, b) { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; }
export function sectionsResponseDb(sections, f) {
  const z1 = [Math.cos(-2 * Math.PI * f / FS), Math.sin(-2 * Math.PI * f / FS)], z2 = cmul(z1, z1);
  let h = [1, 0];
  for (const [b0, b1, b2, a1, a2] of sections) {
    const num = [b0 + b1 * z1[0] + b2 * z2[0], b1 * z1[1] + b2 * z2[1]];
    const den = [1 + a1 * z1[0] + a2 * z2[0], a1 * z1[1] + a2 * z2[1]];
    h = cmul(h, cdiv(num, den));
  }
  return 20 * Math.log10(Math.hypot(h[0], h[1]));
}
export const responseDb = (akm, f, includePregain = true) =>
  sectionsResponseDb(akmSections(akm), f) + (includePregain ? akmPregainDb(akm) : 0);
export const PEAK_GRID = Array.from({ length: 241 }, (_, i) => 20 * 1000 ** (i / 240));
export function maxNetGainDb(akm) {
  const secs = akmSections(akm), pg = akmPregainDb(akm);
  return Math.max(...PEAK_GRID.map(f => sectionsResponseDb(secs, f) + pg));
}
export function checkAkm(akm) {
  const problems = [];
  akmSections(akm).forEach(([, , , a1, a2], n) => {
    const disc = a1 * a1 - 4 * a2;
    const r = disc >= 0 ? Math.max(Math.abs((-a1 + Math.sqrt(disc)) / 2), Math.abs((-a1 - Math.sqrt(disc)) / 2)) : Math.sqrt(a2);
    if (r >= 0.99999) problems.push(`filter ${n} is unstable (pole radius ${r.toFixed(5)})`);
  });
  const net = maxNetGainDb(akm);
  if (net > MAX_NET_GAIN_DB) problems.push(`loudest point ${net.toFixed(2)} dB is above the ${MAX_NET_GAIN_DB} dB limit`);
  return problems;
}

export function customBands(gains) {
  if (gains.length !== 14) throw new Error('Exactly 14 band gains are required');
  gains.forEach(g => { if (!(g >= BAND_GAIN_RANGE[0] && g <= BAND_GAIN_RANGE[1])) throw new Error(`Band gain ${g} dB is outside ±12 dB`); });
  return FACTORY_C_BANDS.slice(0, 14).map(([f, , q], i) => [f, gains[i], q]).concat([FACTORY_C_BANDS[14]]);
}
export function customAkm(gains, pregainDb = null) {
  const header = factoryAkm('0x1af87'), bands = customBands(gains);
  let pregain = pregainDb === null ? P.factoryCPregainDb : pregainDb;
  let akm = buildAkm(bands, pregain, header);
  const excess = maxNetGainDb(akm) - MAX_NET_GAIN_DB;
  if (excess > 0) { pregain -= excess + 0.05; akm = buildAkm(bands, pregain, header); }
  return akm;
}

// ------------------------------------------------------------ slot images

export const slotCpuAddress = slot => { if (!Number.isInteger(slot) || slot < 0 || slot >= NUM_SLOTS) throw new Error('Slot must be an integer 0..4'); return SLOT_CPU_BASE + slot * SLOT_SIZE; };
export const slotFlashAddress = slot => SLOT_FLASH_BASE + slotCpuAddress(slot) - SLOT_CPU_BASE;

// Mic noise gate (WM8994 AIF1 DRC1 downward expander, datasheet pp73-79). Only these fields may differ
// from the factory preset: NG_ENA (0x0440 bit 8), NG_MINGAIN + NG_EXP (0x0442 bits 15:10), KNEE2_IP (0x0444 bits 9:5).
export const GATE_REGS = { enable: 0x0440, exp: 0x0442, knee2: 0x0444 };
export const GATE_FIELD_MASK = { 0x0440: GATE_NG_ENA, 0x0442: 0xfc00, 0x0444: 0x03e0 };
export const GATE_LIMITS = { threshold: [0, 31], ratio: [0, 3], floor: [0, 6] };   // floor 6 = 0 dB; positive gain refused
export const gateThresholdDb = code => -36 - 1.5 * code;
export const gateFloorDb = code => -36 + 6 * code;
export const GATE_RATIOS = [1, 2, 4, 8];

export function decodeGate(pairs) {
  const m = new Map(pairs), exp = m.get(0x0442), knee = m.get(0x0444);
  return { on: !!(m.get(0x0440) & GATE_NG_ENA), threshold: (knee >> 5) & 31, ratio: (exp >> 10) & 3, floor: (exp >> 12) & 15 };
}
export const factoryGate = slot => decodeGate(factoryCodecPairs(descriptor(slot)[0]));

// gate: 'off' | 'on' ('factory' is accepted as 'on' with factory settings); gateSettings: {threshold, ratio, floor} codes.
export function slotCodecPairs(slot, { gate = 'off', codecEq = 'factory', gateSettings = null } = {}) {
  const on = gate === 'on' || gate === 'factory';
  const s = on && gateSettings ? gateSettings : null;
  if (s) {
    for (const [k, [lo, hi]] of Object.entries(GATE_LIMITS)) {
      if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi) throw new Error(`Gate ${k} setting ${s[k]} is out of range`);
    }
  }
  return factoryCodecPairs(descriptor(slot)[0]).map(([r, v]) => {
    if (r === GATE_REG) return [r, on ? v | GATE_NG_ENA : v & ~GATE_NG_ENA];
    if (r === 0x0442 && s) return [r, (v & ~0xfc00) | (s.floor << 12) | (s.ratio << 10)];
    if (r === 0x0444 && s) return [r, (v & ~0x03e0) | (s.threshold << 5)];
    if (r === AIF2_EQ_REG && codecEq === 'off') return [r, v & ~AIF2_EQ_ENA];
    return [r, v];
  });
}

export function buildSlotImage(slot, codecPairs, akm) {
  const base = slotCpuAddress(slot);
  if (akm.length !== AKM_BYTES) throw new Error('AKM preset must be 243 bytes');
  const codecPtr = base + SLOT_HEADER, akmPtr = codecPtr + 4 * codecPairs.length;
  if (akmPtr + akm.length - base > CHECKSUM_SPAN[1]) throw new Error('Payload does not fit the checksummed slot area');
  const body = new Uint8Array(SLOT_SIZE).fill(0xff);
  putU32(body, 0, 0); putU16(body, 4, codecPairs.length); putU16(body, 6, 0); putU32(body, 8, codecPtr);
  putU16(body, 0xc, akm.length); putU16(body, 0xe, 0); putU32(body, 0x10, akmPtr);
  codecPairs.forEach(([r, v], i) => { putU16(body, SLOT_HEADER + 4 * i, r); putU16(body, SLOT_HEADER + 4 * i + 2, v); });
  body.set(akm, akmPtr - base);
  putU32(body, 0, adler32(body.subarray(CHECKSUM_SPAN[0], CHECKSUM_SPAN[1])));
  return body;
}

export const customImage = (slot, gains, pregainDb, opts) => buildSlotImage(slot, slotCodecPairs(slot, opts), customAkm(gains, pregainDb));
export const factoryCurveImage = (slot, opts) => buildSlotImage(slot, slotCodecPairs(slot, opts), factoryAkm(descriptor(slot)[1]));

export function simulateLoader(slot, image) {
  const base = slotCpuAddress(slot);
  if (image.length !== SLOT_SIZE) throw new Error('Slot image must be 1024 bytes');
  if (adler32(image.subarray(CHECKSUM_SPAN[0], CHECKSUM_SPAN[1])) !== u32(image, 0)) {
    const [codecVa, akmVa] = descriptor(slot);
    return { source: 'default', codecPairs: factoryCodecPairs(codecVa), akm: factoryAkm(akmVa) };
  }
  const count = u16(image, 4), codecPtr = u32(image, 8), akmLen = u16(image, 0xc), akmPtr = u32(image, 0x10);
  const inside = (ptr, n) => base + SLOT_HEADER <= ptr && ptr + n <= base + CHECKSUM_SPAN[1];
  if (!inside(codecPtr, 4 * count)) throw new Error('Codec pointer/count leaves the checksummed slot area');
  if (!inside(akmPtr, akmLen)) throw new Error('AKM pointer/length leaves the checksummed slot area');
  if (akmLen % 3) throw new Error('AKM length not a multiple of 3');
  const off = codecPtr - base, codecPairs = [];
  for (let i = 0; i < count; i++) codecPairs.push([u16(image, off + 4 * i), u16(image, off + 4 * i + 2)]);
  return { source: 'custom', codecPairs, akm: image.slice(akmPtr - base, akmPtr - base + akmLen) };
}

// Safety policy. allowGateOn: the user explicitly chose the factory noise gate for this slot.
export function checkSlotImage(slot, image, { allowGateOn = false } = {}) {
  let loaded;
  try { loaded = simulateLoader(slot, image); } catch (e) { return [e.message]; }
  if (loaded.source !== 'custom') return ['checksum does not validate; the MixAmp would load the factory preset'];
  const ref = new Map(factoryCodecPairs(descriptor(slot)[0]));
  const problems = [], seen = new Set();
  for (const [r, v] of loaded.codecPairs) {
    if (seen.has(r)) problems.push(`duplicate codec register 0x${r.toString(16)}`);
    seen.add(r);
    const allowed = r === AIF2_EQ_REG ? AIF2_EQ_ENA : (GATE_FIELD_MASK[r] || 0);
    if (!ref.has(r)) problems.push(`codec register 0x${r.toString(16).padStart(4, '0')} is not in the factory preset register set`);
    else if ((v & ~allowed) !== (ref.get(r) & ~allowed)) problems.push(`codec register 0x${r.toString(16)} changes more than its adjustable fields`);
    else if (r === GATE_REG && (v & GATE_NG_ENA) && !allowGateOn) problems.push('noise gate is enabled');
  }
  const g = decodeGate(loaded.codecPairs);
  if (g.floor > GATE_LIMITS.floor[1]) problems.push(`gate floor code ${g.floor} would boost quiet sound; 0 dB is the most allowed`);
  if (loaded.akm.length !== AKM_BYTES) problems.push('AKM payload is not 243 bytes');
  else problems.push(...checkAkm(loaded.akm));
  return problems;
}

export function describeSlot(slot, image) {
  if (equalBytes(image, ERASED_SLOT)) return { state: 'empty', label: 'Empty (factory preset loads)' };
  let loaded;
  try { loaded = simulateLoader(slot, image); } catch (e) { return { state: 'broken', label: `Checksum valid but structure rejected: ${e.message}` }; }
  if (loaded.source !== 'custom') return { state: 'invalid', label: 'Invalid checksum (factory preset loads)' };
  const pairs = new Map(loaded.codecPairs);
  const curve = TABLES ? Object.entries(TABLES.akmArrays).find(([, bytes]) => equalBytes(bytes, loaded.akm)) : null;
  return {
    state: 'custom', label: 'Custom preset',
    gate: (pairs.get(GATE_REG) & GATE_NG_ENA) ? 'on' : 'off',
    gateSettings: decodeGate(loaded.codecPairs),
    codecEq: (pairs.get(AIF2_EQ_REG) & AIF2_EQ_ENA) ? 'factory' : 'off',
    curve: curve ? `factory curve ${({ '0x1b07a': 'A', '0x1ae94': 'B', '0x1af87': 'C' })[curve[0]]}` : TABLES ? 'custom curve' : 'curve (connect to identify)',
    pregainDb: akmPregainDb(loaded.akm), netPeakDb: maxNetGainDb(loaded.akm), akm: loaded.akm,
  };
}

// ------------------------------------------------------------ HID framing

export function commandStream(op, args, seq, payload = new Uint8Array(0)) {
  const words = new Uint8Array(16);
  putU32(words, 0, (0x00110000 | ((seq & 255) << 8) | op) >>> 0);
  args.forEach((a, i) => putU32(words, 4 + 4 * i, a >>> 0));
  let sum = 0;
  words.forEach((b, i) => { sum += b ^ i; });
  const out = new Uint8Array(18 + payload.length);
  out[0] = 0x7e; out.set(words, 1); out[17] = sum & 255; out.set(payload, 18);
  return out;
}
// 64-byte output reports (WebHID adds report ID 0): [length][up to 63 stream bytes][0xFF padding].
export function hidReports(stream) {
  const reports = [];
  for (let pos = 0; pos < stream.length; pos += 63) {
    const chunk = stream.subarray(pos, pos + 63), r = new Uint8Array(64).fill(0xff);
    r[0] = chunk.length; r.set(chunk, 1);
    reports.push(r);
  }
  return reports;
}
const xorFold = (bytes, seed = 0x42) => bytes.reduce((a, b) => a ^ b, seed);

// Validates one reply stream; returns { error, scalar, payload }.
export function parseReply(stream, seq) {
  if (stream.length < 18 || stream[0] !== 0x40) throw new Error('Reply does not start with @');
  if (xorFold(stream.subarray(1, 18)) !== 0) throw new Error('Bad reply header checksum');
  const tag = u32(stream, 1), error = u32(stream, 5), scalar = u32(stream, 9), length = u32(stream, 13);
  if (tag !== (0x1100 | seq)) throw new Error(`Reply tag 0x${tag.toString(16)} does not match request ${seq}`);
  const expected = length ? 18 + length + 1 : 18;
  if (stream.length !== expected) throw new Error(`Reply is ${stream.length} bytes, expected ${expected}`);
  let payload = new Uint8Array(0);
  if (length) {
    if (xorFold(stream.subarray(18)) !== 0) throw new Error('Bad reply payload checksum');
    payload = stream.slice(18, 18 + length);
  }
  return { error, scalar, payload };
}
// Expected stream length once the header is known (null until 18 bytes are in).
export function expectedReplyLength(stream) {
  if (stream.length < 18) return null;
  const length = u32(stream, 13);
  return length ? 18 + length + 1 : 18;
}

export function decodeVersion(scalar) {
  return { firmware: scalar >>> 16, model: scalar & 0xffff, raw: scalar };
}
export function decodeSys(payload) {
  if (payload.length !== 12) throw new Error('Sys reply must be 12 bytes');
  return { dolbySelected: !!(payload[4] & 1), presetIndex: u32(payload, 8), hex: bytesToHex(payload) };
}

// The only flash write this app can build: one 1 KB preset-slot sector.
export function slotWriteStream(slot, image, seq, policy = {}) {
  const flash = slotFlashAddress(slot);
  const allowed = Array.from({ length: NUM_SLOTS }, (_, n) => SLOT_FLASH_BASE + n * SLOT_SIZE);
  if (!allowed.includes(flash) || (flash & 0x3ff) || !(flash & 0x800000)) throw new Error('Refusing a flash address outside the five preset slots');
  if (image.length !== SLOT_SIZE) throw new Error('Slot image must be exactly 1024 bytes');
  if (!equalBytes(image, ERASED_SLOT)) {
    const problems = checkSlotImage(slot, image, policy);
    if (problems.length) throw new Error('Slot image fails the safety checks: ' + problems.join('; '));
  }
  return commandStream(OP.FLASH_FROM_USB, [flash, SLOT_SIZE, 0], seq, image);
}
