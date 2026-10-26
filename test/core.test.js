// Checks the JavaScript core against golden images built by ma3_preset_slot.py. No device access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../ma3-core.js';
import { fixtureTest, golden } from '../test-support/fixtures.js';

const hex = core.bytesToHex;

test('Adler-32 matches the firmware routine', () => {
  assert.equal(core.adler32(new Uint8Array(0)), 1);
  assert.equal(core.adler32(new TextEncoder().encode('abc')), 0x024d0127);
});

test('factory data is locked until verified tables are loaded', async () => {
  core.clearFactoryTables();
  assert.equal(core.factoryTablesLoaded(), false);
  assert.throws(() => core.factoryAkm('0x1af87'), /Connect the MixAmp/);
  const [codec, akm] = core.FACTORY_TABLE_RANGES;
  await assert.rejects(core.setFactoryTables(new Uint8Array(codec.length), new Uint8Array(akm.length)), /does not match/);
  await assert.rejects(core.setFactoryTables(new Uint8Array(10), new Uint8Array(akm.length)), /wrong size/);
  assert.equal(core.factoryTablesLoaded(), false);
});

fixtureTest('custom slot images are byte-identical to the Python builder', async () => {
  for (const c of golden.cases.filter(c => c.kind === 'custom')) {
    const image = core.customImage(c.slot, c.gains, c.pregain, { gate: 'off', codecEq: c.codecEq });
    assert.equal(hex(image), c.imageHex, `slot ${c.slot} gains ${c.gains}`);
    assert.equal(await core.sha256Hex(image), c.sha256);
    assert.deepEqual(core.checkSlotImage(c.slot, image).length === 0, c.problems.length === 0);
  }
});

fixtureTest('factory-curve clones match the Python gate-off clones', () => {
  for (const c of golden.cases.filter(c => c.kind === 'factoryClone')) {
    assert.equal(hex(core.factoryCurveImage(c.slot, { gate: 'off', codecEq: 'factory' })), c.imageHex);
  }
});

fixtureTest('the Harman image on the device decodes as a custom curve with codec EQ off', () => {
  const c = golden.cases[0];
  const d = core.describeSlot(3, core.hexToBytes(c.imageHex));
  assert.equal(d.state, 'custom');
  assert.equal(d.codecEq, 'off');
  assert.equal(d.gate, 'off');
  assert.equal(d.curve, 'custom curve');
  assert.ok(Math.abs(d.pregainDb + 9.32) < 0.01);
});

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

fixtureTest('framing matches the Python packet builders', () => {
  for (const [i, h] of golden.backupReads.entries()) {
    const report = core.hidReports(core.commandStream(core.OP.READ_MEM, [0x200000 + 256 * i, 256, 0], i + 1))[0];
    assert.equal('00' + hex(report), h);
  }
  const clone = core.factoryCurveImage(3, { gate: 'off' });
  assert.equal('00' + hex(core.hidReports(core.slotWriteStream(3, clone, 33))[0]), golden.writeFirstReport);
});

test('slot writes only ever target the five data-flash slot sectors', () => {
  for (let s = 0; s < 5; s++) assert.equal(core.slotFlashAddress(s), 0x800400 + 0x400 * s);
  assert.throws(() => core.slotFlashAddress(5));
  assert.throws(() => core.slotWriteStream(3, new Uint8Array(1000), 1));
  assert.throws(() => core.slotWriteStream(3, new Uint8Array(1024), 1));       // zeros: fails checks
  const stream = core.slotWriteStream(2, core.ERASED_SLOT, 9);               // restore-to-factory image
  assert.equal(stream.length, 18 + 1024);
});

test('reply parsing enforces tag, length and checksums', () => {
  const header = new Uint8Array(16);
  const put = (o, v) => { header[o] = v >>> 24; header[o + 1] = (v >>> 16) & 255; header[o + 2] = (v >>> 8) & 255; header[o + 3] = v & 255; };
  put(0, 0x1105); put(8, 0x0d2e1005);
  const csum = header.reduce((a, b) => a ^ b, 0x42);
  const stream = Uint8Array.from([0x40, ...header, csum]);
  const r = core.parseReply(stream, 5);
  assert.deepEqual(core.decodeVersion(r.scalar), { firmware: 3374, model: 0x1005, raw: 0x0d2e1005 });
  assert.throws(() => core.parseReply(stream, 6));
  const bad = stream.slice(); bad[10] ^= 1;
  assert.throws(() => core.parseReply(bad, 5));
  assert.throws(() => core.parseReply(Uint8Array.from([...stream, 0xff]), 5));
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
