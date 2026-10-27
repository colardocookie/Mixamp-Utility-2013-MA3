import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as eq from '../ma3-eq.js';
import { core, loadTables, golden } from '../test-support/synthetic.js';
const fixtureTest = (name, fn) => test(name, async t => { await loadTables(); return fn(t); });
fixtureTest('loader simulation: erased, zeroed and tampered slots fall back to factory', () => {
  assert.equal(core.simulateLoader(1, core.ERASED_SLOT).source, 'default');
  assert.equal(core.simulateLoader(1, new Uint8Array(1024)).source, 'default');
  const img = core.hexToBytes(golden.cases[0].imageHex);
  img[0x40] ^= 1;
  assert.equal(core.simulateLoader(3, img).source, 'default');
  assert.equal(core.describeSlot(3, core.ERASED_SLOT).state, 'empty');
});

fixtureTest('safety policy rejects gate on unless chosen, foreign registers, and loud curves', () => {
  const gateOn = core.customImage(3, Array(14).fill(0), -12, { gate: 'factory', codecEq: 'factory' });
  assert.ok(core.checkSlotImage(3, gateOn).some(p => p.includes('noise gate')));
  assert.deepEqual(core.checkSlotImage(3, gateOn, { allowGateOn: true }), []);
  const pairs = core.slotCodecPairs(3).concat([[0x0000, 0]]);
  const bad = core.buildSlotImage(3, pairs, core.customAkm(Array(14).fill(0)));
  assert.ok(core.checkSlotImage(3, bad).some(p => p.includes('0x0000')));
  const loud = core.buildSlotImage(3, core.slotCodecPairs(3), core.buildAkm(core.customBands(Array(14).fill(12)).map(b => b), 0, core.factoryAkm('0x1af87')));
  assert.ok(core.checkSlotImage(3, loud).some(p => p.includes('limit')));
});

fixtureTest('adjustable mic gate: settings land in the right fields and pass the checks', () => {
  const s = { threshold: 16, ratio: 1, floor: 4 };   // -60 dB, 2:1, -12 dB
  const image = core.customImage(3, Array(14).fill(0), -12, { gate: 'on', codecEq: 'off', gateSettings: s });
  assert.deepEqual(core.checkSlotImage(3, image, { allowGateOn: true }), []);
  const d = core.describeSlot(3, image);
  assert.equal(d.gate, 'on');
  assert.deepEqual(d.gateSettings, { on: true, ...s });
  assert.equal(core.gateThresholdDb(16), -60);
  assert.equal(core.gateFloorDb(4), -12);
  const f = core.factoryGate(3);
  assert.deepEqual([f.threshold, f.ratio, f.floor], [12, 2, 0]);   // -54 dB, 4:1, -36 dB
  const off = core.describeSlot(3, core.customImage(3, Array(14).fill(0), -12, { gate: 'off', gateSettings: s }));
  assert.equal(off.gate, 'off');
  assert.deepEqual([off.gateSettings.threshold, off.gateSettings.floor], [12, 0]);   // settings ignored when off
});

fixtureTest('adjustable mic gate: out-of-range values and other DRC bits are refused', () => {
  assert.throws(() => core.slotCodecPairs(3, { gate: 'on', gateSettings: { threshold: 32, ratio: 1, floor: 0 } }), /out of range/);
  assert.throws(() => core.slotCodecPairs(3, { gate: 'on', gateSettings: { threshold: 10, ratio: 1, floor: 7 } }), /out of range/);
  const akm = core.customAkm(Array(14).fill(0), -12);
  const boost = core.slotCodecPairs(3, { gate: 'on' }).map(([r, v]) => [r, r === 0x0442 ? (v & ~0xf000) | (8 << 12) : v]);
  assert.ok(core.checkSlotImage(3, core.buildSlotImage(3, boost, akm), { allowGateOn: true }).some(p => p.includes('boost')));
  const qr = core.slotCodecPairs(3, { gate: 'on' }).map(([r, v]) => [r, r === 0x0442 ? v ^ 0x0100 : v]);
  assert.ok(core.checkSlotImage(3, core.buildSlotImage(3, qr, akm), { allowGateOn: true }).some(p => p.includes('adjustable fields')));
  const attack = core.slotCodecPairs(3).map(([r, v]) => [r, r === 0x0441 ? v ^ 0x0200 : v]);
  assert.ok(core.checkSlotImage(3, core.buildSlotImage(3, attack, akm)).some(p => p.includes('0x441')));
});

fixtureTest('an imported profile becomes a slot image that passes the safety checks', () => {
  const p = eq.parseAutoEqProfile('Preamp: -6 dB\nFilter 1: ON LSC Fc 105 Hz Gain 8.0 dB Q 0.70\nFilter 2: ON PK Fc 3000 Hz Gain -4.0 dB Q 2\n');
  const fit = eq.fitBands(eq.GRID.map((f, i) => [f, p.correction[i]]));
  const image = core.customImage(3, fit.gains, -12, { gate: 'off', codecEq: 'off' });
  assert.deepEqual(core.checkSlotImage(3, image), []);
});
