// Device-layer tests against a fake WebHID MixAmp (no real device access).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../ma3-core.js';
import { MixAmp } from '../ma3-device.js';
import { fixtureTest, golden, tables } from '../test-support/fixtures.js';

const STAGE1 = golden ? core.hexToBytes(golden.cases.find(c => c.kind === 'factoryClone' && c.slot === 3).imageHex) : new Uint8Array(1024).fill(0xff);
const HARMAN = golden ? core.hexToBytes(golden.cases[0].imageHex) : null;
const PROGRAM = tables ? { [core.FACTORY_TABLE_RANGES[0].address]: core.hexToBytes(tables.codec), [core.FACTORY_TABLE_RANGES[1].address]: core.hexToBytes(tables.akm) } : {};

function reply(seq, { payload = new Uint8Array(0), scalar = 0, error = 0 } = {}) {
  const h = new Uint8Array(16), put = (o, v) => { h[o] = v >>> 24; h[o + 1] = (v >>> 16) & 255; h[o + 2] = (v >>> 8) & 255; h[o + 3] = v & 255; };
  put(0, 0x1100 | seq); put(4, error); put(8, scalar); put(12, payload.length);
  const out = [0x40, ...h, h.reduce((a, b) => a ^ b, 0x42)];
  if (payload.length) out.push(...payload, payload.reduce((a, b) => a ^ b, 0x42));
  return Uint8Array.from(out);
}

class FakeHid {
  constructor(amp, { slot3 = STAGE1, duplicateRead = 0, flashError = 0, corrupt = false, tamper = false } = {}) {
    Object.assign(this, { amp, duplicateRead, flashError, corrupt, tamper, reads: 0, ops: [], pending: [] });
    this.flash = new Uint8Array(0x1800).fill(0xff);
    this.flash.set(slot3, 0x1000);
    this.flash.set(core.hexToBytes('000b0004000000000000000' + '3'), 0);
  }
  emit(stream) {
    for (const r of core.hidReports(stream)) setTimeout(() => this.amp._onInput({ data: new DataView(r.buffer) }), 0);
  }
  async sendReport(id, r) {
    assert.equal(id, 0); assert.equal(r.length, 64);
    this.pending.push(...r.subarray(1, 1 + r[0]));
    if (this.pending.length < 18) return;
    const s = Uint8Array.from(this.pending), dv = new DataView(s.buffer);
    const w0 = dv.getUint32(1), a1 = dv.getUint32(5), a2 = dv.getUint32(9), op = w0 & 255, seq = (w0 >>> 8) & 255;
    if (op === core.OP.FLASH_FROM_USB && s.length < 18 + a2) return;
    this.pending = [];
    this.ops.push(op);
    if (op === core.OP.VERSION) this.emit(reply(seq, { scalar: 0x0d2e1005 }));
    else if (op === core.OP.READ_MEM) {
      assert.ok(a2 >= 1 && a2 <= 32);
      let payload;
      if (a1 >= 0x200000 && a1 + a2 <= 0x201800) payload = this.flash.slice(a1 - 0x200000, a1 - 0x200000 + a2);
      else {
        const [base, bytes] = Object.entries(PROGRAM).map(([b, v]) => [+b, v]).find(([b, v]) => a1 >= b && a1 + a2 <= b + v.length) || [];
        assert.ok(bytes, `read outside the allowed ranges: 0x${a1.toString(16)}`);
        payload = bytes.slice(a1 - base, a1 - base + a2);
        if (this.tamper) payload[0] ^= 1;
      }
      this.reads++;
      const out = reply(seq, { payload });
      this.emit(out);
      if (this.reads === this.duplicateRead) this.emit(out);
    } else if (op === core.OP.FLASH_FROM_USB) {
      assert.ok([0x800400, 0x800800, 0x800c00, 0x801000, 0x801400].includes(a1) && a2 === 1024);
      const data = s.slice(18);
      if (this.corrupt) data[200] ^= 1;
      if (!this.flashError) this.flash.set(data, a1 - 0x800000);
      this.emit(reply(seq, { error: this.flashError }));
    } else if (op === core.OP.READ_SYS) this.emit(reply(seq, { payload: this.flash.slice(0, 12) }));
    else if (op === core.OP.READ_CODEC) this.emit(reply(seq, { scalar: a1 === 0x440 ? 0x000b : 0x88db }));
    else throw new Error('unexpected opcode ' + op);
  }
}

function setup(opts) {
  const amp = new MixAmp(() => {});
  const fake = new FakeHid(amp, opts);
  amp.device = fake;
  amp.identity = { firmware: 3374, model: 0x1005 };
  return { amp, fake };
}

fixtureTest('backup reads exactly the Sys sector and five slots in 32-byte pieces', async () => {
  const { amp, fake } = setup();
  const data = await amp.readBackup();
  assert.equal(data.length, 0x1800);
  assert.equal(fake.reads, 192);
  assert.ok(core.equalBytes(amp.slotFromBackup(3), STAGE1));
});

test('status read decodes preset, gate and codec EQ', async () => {
  const { amp } = setup();
  const s = await amp.readStatus();
  assert.equal(s.presetIndex, 3);
  assert.equal(s.gateOn, false);
  assert.equal(s.codecEqOn, true);
});

fixtureTest('write requires a backup on this connection', async () => {
  const { amp, fake } = setup();
  await assert.rejects(amp.writeSlot(3, HARMAN), /Back up/);
  assert.deepEqual(fake.ops, []);
});

fixtureTest('write: pre-read, one flash write to slot 3, read-back', async () => {
  const { amp, fake } = setup();
  await amp.readBackup();
  fake.ops = [];
  await amp.writeSlot(3, HARMAN);
  assert.deepEqual(fake.ops.filter(o => o === core.OP.FLASH_FROM_USB).length, 1);
  assert.ok(core.equalBytes(fake.flash.slice(0x1000, 0x1400), HARMAN));
  assert.ok(core.equalBytes(amp.slotFromBackup(3), HARMAN));
  assert.ok(fake.flash.slice(0, 0x1000).every((b, i) => i < 12 || b === 0xff));
});

fixtureTest('restore to factory writes an empty slot', async () => {
  const { amp, fake } = setup();
  await amp.readBackup();
  await amp.writeSlot(3, core.ERASED_SLOT);
  assert.ok(fake.flash.slice(0x1000, 0x1400).every(b => b === 0xff));
});

fixtureTest('slot changed outside the page: no write, page re-reads it, second press overwrites', async () => {
  const { amp, fake } = setup();
  await amp.readBackup();
  fake.flash.set(HARMAN, 0x1000);
  fake.ops = [];
  const other = core.ERASED_SLOT;
  await assert.rejects(amp.writeSlot(3, other), /changed outside this page/);
  assert.ok(!fake.ops.includes(core.OP.FLASH_FROM_USB));
  assert.ok(core.equalBytes(amp.slotFromBackup(3), HARMAN));
  await amp.writeSlot(3, other);
  assert.equal(fake.ops.filter(o => o === core.OP.FLASH_FROM_USB).length, 1);
});

fixtureTest('a slot that already holds a custom preset can be overwritten directly', async () => {
  const { amp, fake } = setup({ slot3: HARMAN });
  await amp.readBackup();
  const next = core.customImage(3, Array(14).fill(0), -12, { gate: 'off', codecEq: 'off' });
  await amp.writeSlot(3, next);
  assert.ok(core.equalBytes(fake.flash.slice(0x1000, 0x1400), next));
  const again = core.customImage(3, Array(14).fill(1), -12, { gate: 'off', codecEq: 'off' });
  await amp.writeSlot(3, again);
  assert.ok(core.equalBytes(fake.flash.slice(0x1000, 0x1400), again));
});

fixtureTest('a duplicated reply report stops the operation', async () => {
  const { amp, fake } = setup({ duplicateRead: 50 });
  await assert.rejects(amp.readBackup(), /extra data/);
  assert.equal(fake.reads, 50);
  assert.equal(amp.backup, null);
});

fixtureTest('flash error and read-back mismatch are reported, never retried', async () => {
  let { amp, fake } = setup({ flashError: 0x10 });
  await amp.readBackup();
  await assert.rejects(amp.writeSlot(3, HARMAN), /flash error/);
  assert.equal(fake.ops.filter(o => o === core.OP.FLASH_FROM_USB).length, 1);
  ({ amp, fake } = setup({ corrupt: true }));
  await amp.readBackup();
  await assert.rejects(amp.writeSlot(3, HARMAN), /does not match/);
  assert.equal(fake.ops.filter(o => o === core.OP.FLASH_FROM_USB).length, 1);
});

fixtureTest('images failing the safety checks are refused before any IO', async () => {
  const { amp, fake } = setup();
  await amp.readBackup();
  fake.ops = [];
  await assert.rejects(amp.writeSlot(3, new Uint8Array(1024)), /safety checks/);
  const gateOn = core.customImage(3, Array(14).fill(0), -12, { gate: 'factory', codecEq: 'factory' });
  await assert.rejects(amp.writeSlot(3, gateOn), /noise gate/);
  assert.deepEqual(fake.ops, []);
});

test('only one operation at a time', async () => {
  const { amp } = setup();
  const first = amp.readBackup();
  await assert.rejects(amp.readStatus(), /Another operation/);
  await first;
});

test('memory reads are limited to the backup and factory-table ranges', async () => {
  assert.ok(MixAmp.readAllowed(0x200000, 32));
  assert.ok(MixAmp.readAllowed(0x2017e0, 32));
  assert.ok(MixAmp.readAllowed(core.FACTORY_TABLE_RANGES[0].address, 368));
  assert.ok(!MixAmp.readAllowed(0x201800, 1));
  assert.ok(!MixAmp.readAllowed(0x10000, 32));
  assert.ok(!MixAmp.readAllowed(0x800000, 32));
  const amp = new MixAmp(() => {});
  amp.device = { sendReport: () => assert.fail('nothing may be sent') };
  amp.identity = { firmware: 3374, model: 0x1005 };
  await assert.rejects(amp._readMemory(0xffff8000, 32), /Refusing to read/);
});

fixtureTest('factory tables are read from the MixAmp and verified', async () => {
  core.clearFactoryTables();
  const { amp, fake } = setup();
  await amp.readFactoryTables();
  assert.ok(core.factoryTablesLoaded());
  assert.equal(fake.reads, Math.ceil(368 / 32) + Math.ceil(729 / 32));
  core.clearFactoryTables();
  const bad = setup({ tamper: true });
  await assert.rejects(bad.amp.readFactoryTables(), /does not match/);
  assert.equal(core.factoryTablesLoaded(), false);
});
