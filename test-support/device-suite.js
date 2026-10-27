import assert from 'node:assert/strict';

// Shared scenarios run with synthetic inputs and, optionally, real golden inputs.
export function deviceSuite({ core, MixAmp, fixtureTest, golden, tables, extended = true, portableTest = fixtureTest }) {
  const INITIAL_SLOT = golden ? core.hexToBytes(golden.cases.find(c => c.kind === 'factoryClone' && c.slot === 3).imageHex) : new Uint8Array(1024).fill(0xff);
  const WRITE_IMAGE = golden ? core.hexToBytes(golden.cases[0].imageHex) : null;
  const PROGRAM = tables ? { [core.FACTORY_TABLE_RANGES[0].address]: core.hexToBytes(tables.codec), [core.FACTORY_TABLE_RANGES[1].address]: core.hexToBytes(tables.akm) } : {};

  function reply(seq, { payload = new Uint8Array(0), scalar = 0, error = 0 } = {}) {
    const h = new Uint8Array(16), put = (o, v) => { h[o] = v >>> 24; h[o + 1] = (v >>> 16) & 255; h[o + 2] = (v >>> 8) & 255; h[o + 3] = v & 255; };
    put(0, 0x1100 | seq); put(4, error); put(8, scalar); put(12, payload.length);
    const out = [0x40, ...h, h.reduce((a, b) => a ^ b, 0x42)];
    if (payload.length) out.push(...payload, payload.reduce((a, b) => a ^ b, 0x42));
    return Uint8Array.from(out);
  }

  class FakeHid {
    constructor(amp, { slot3 = INITIAL_SLOT, duplicateRead = 0, flashError = 0, corrupt = false, tamper = false, fault = null, version = 0x0d2e1005 } = {}) {
      Object.assign(this, { amp, duplicateRead, flashError, corrupt, tamper, reads: 0, ops: [], commands: [], pending: [], fault, version, opened: false, listeners: new Map(), vendorId: 0x9886, productId: 2, collections: [{ usagePage: 0xff31, usage: 0x74 }] });
      this.flash = new Uint8Array(0x1800).fill(0xff);
      this.flash.set(slot3, 0x1000);
      this.flash.set(core.hexToBytes('000b0004000000000000000' + '3'), 0);
    }
    async open() { this.opened = true; }
    async close() { this.opened = false; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    emit(stream) {
      // Independently frame replies (do not use the production HID encoder).
      for (let off = 0; off < stream.length; off += 63) {
        let r = new Uint8Array(64).fill(0xff);
        r[0] = Math.min(63, stream.length - off);
        r.set(stream.subarray(off, off + r[0]), 1);
        if (this.fault) r = this.fault(r, this.commands.at(-1), this);
        setTimeout(() => (this.listeners.get('inputreport') || this.amp._input)({ data: new DataView(r.buffer, r.byteOffset, r.byteLength) }), 0);
      }
    }
    async sendReport(id, r) {
      assert.equal(id, 0); assert.equal(r.length, 64);
      assert.ok(r[0] > 0 && r[0] <= 63);
      assert.ok(r.subarray(1 + r[0]).every(b => b === 0xff));
      this.pending.push(...r.subarray(1, 1 + r[0]));
      if (this.pending.length < 18) return;
      const s = Uint8Array.from(this.pending), dv = new DataView(s.buffer);
      const w0 = dv.getUint32(1), a1 = dv.getUint32(5), a2 = dv.getUint32(9), op = w0 & 255, seq = (w0 >>> 8) & 255;
      if (op === 9 && s.length < 18 + a2) return;
      assert.equal(w0 >>> 16, 0x11);
    assert.ok(seq >= 1 && seq <= 255);
    assert.equal(s[0], 0x7e);
      assert.equal(s[17], s.subarray(1, 17).reduce((sum, b, i) => sum + (b ^ i), 0) & 255);
      assert.equal(s.length, op === 9 ? 18 + a2 : 18);
      this.pending = [];
      this.ops.push(op);
      this.commands.push({ op, address: a1, length: a2 });
      if (op === 0) this.emit(reply(seq, { scalar: this.version }));
      else if (op === 24) {
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
      } else if (op === 9) {
        assert.ok([0x800400, 0x800800, 0x800c00, 0x801000, 0x801400].includes(a1) && a2 === 1024);
        const data = s.slice(18);
        if (this.corrupt) data[200] ^= 1;
        if (!this.flashError) this.flash.set(data, a1 - 0x800000);
        this.emit(reply(seq, { error: this.flashError }));
      } else if (op === 27) this.emit(reply(seq, { payload: this.flash.slice(0, 12) }));
      else if (op === 7) this.emit(reply(seq, { scalar: a1 === 0x440 ? 0x000b : 0x88db }));
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
    assert.ok(core.equalBytes(amp.slotFromBackup(3), INITIAL_SLOT));
  });

  portableTest('status read decodes preset, gate and codec EQ', async () => {
    const { amp } = setup();
    const s = await amp.readStatus();
    assert.equal(s.presetIndex, 3);
    assert.equal(s.gateOn, false);
    assert.equal(s.codecEqOn, true);
  });

  fixtureTest('write requires a backup on this connection', async () => {
    const { amp, fake } = setup();
    await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /Back up/);
    assert.deepEqual(fake.ops, []);
  });

  fixtureTest('write: pre-read, one flash write to slot 3, read-back', async () => {
    const { amp, fake } = setup();
    await amp.readBackup();
    fake.ops = []; fake.commands = [];
    const original = fake.flash.slice();
    await amp.writeSlot(3, WRITE_IMAGE);
    assert.deepEqual(fake.ops, [...Array(32).fill(core.OP.READ_MEM), core.OP.FLASH_FROM_USB, ...Array(32).fill(core.OP.READ_MEM)]);
    assert.deepEqual(fake.commands.filter(c => c.op === core.OP.FLASH_FROM_USB), [{ op: core.OP.FLASH_FROM_USB, address: 0x801000, length: 1024 }]);
    assert.ok(core.equalBytes(fake.flash.slice(0x1000, 0x1400), WRITE_IMAGE));
    assert.ok(core.equalBytes(amp.slotFromBackup(3), WRITE_IMAGE));
    assert.deepEqual(fake.flash.slice(0, 0x1000), original.slice(0, 0x1000));
    assert.deepEqual(fake.flash.slice(0x1400), original.slice(0x1400));
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
    fake.flash.set(WRITE_IMAGE, 0x1000);
    fake.ops = [];
    const other = core.ERASED_SLOT;
    await assert.rejects(amp.writeSlot(3, other), /changed outside this page/);
    assert.ok(!fake.ops.includes(core.OP.FLASH_FROM_USB));
    assert.ok(core.equalBytes(amp.slotFromBackup(3), WRITE_IMAGE));
    await amp.writeSlot(3, other);
    assert.equal(fake.ops.filter(o => o === core.OP.FLASH_FROM_USB).length, 1);
  });

  fixtureTest('a slot that already holds a custom preset can be overwritten directly', async () => {
    const { amp, fake } = setup({ slot3: WRITE_IMAGE });
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
    const backup = amp.backup.slice();
    await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /flash error/);
    assert.deepEqual(amp.backup, backup);
    assert.equal(fake.ops.filter(o => o === core.OP.FLASH_FROM_USB).length, 1);
    ({ amp, fake } = setup({ corrupt: true }));
    await amp.readBackup();
    await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /does not match/);
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

  portableTest('only one operation at a time', async () => {
    const { amp } = setup();
    const first = amp.readBackup();
    await assert.rejects(amp.readStatus(), /Another operation/);
    await first;
  });

  portableTest('memory reads are limited to the backup and factory-table ranges', async () => {
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

  if (extended) {
  fixtureTest('every permitted slot writes exactly its own sector and verifies all bytes', async () => {
    for (let slot = 0; slot < 5; slot++) {
      const { amp, fake } = setup();
      await amp.readBackup();
      const before = fake.flash.slice();
      const image = core.customImage(slot, Array(14).fill(slot - 2), -12, { gate: 'off' });
      await amp.writeSlot(slot, image);
      const offset = 0x400 * (slot + 1);
      assert.deepEqual(fake.flash.slice(offset, offset + 1024), image);
      assert.deepEqual(fake.flash.slice(0, offset), before.slice(0, offset));
      assert.deepEqual(fake.flash.slice(offset + 1024), before.slice(offset + 1024));
      assert.deepEqual(fake.commands.filter(c => c.op === core.OP.FLASH_FROM_USB),
        [{ op: core.OP.FLASH_FROM_USB, address: 0x800000 + offset, length: 1024 }]);
      assert.deepEqual(amp.slotFromBackup(slot), image);
    }
  });

  fixtureTest('invalid slots and image sizes never reach USB', async () => {
    const { amp, fake } = setup();
    await amp.readBackup(); fake.ops = [];
    for (const slot of [-1, 5, 0.5, NaN, Infinity, '3', null, undefined]) {
      await assert.rejects(amp.writeSlot(slot, core.ERASED_SLOT));
    }
    for (const size of [0, 1023, 1025]) await assert.rejects(amp.writeSlot(3, new Uint8Array(size)));
    assert.deepEqual(fake.ops, []);
  });

  fixtureTest('malformed replies during the pre-read leave flash and backup unchanged', async () => {
    const faults = [
      r => r.slice(0, 63),
      r => { r[0] = 0; return r; },
      r => { r[0] = 64; return r; },
      r => { r[63] = 0; return r; },
      r => { r[1] = 0; return r; },
      r => { r[18] ^= 1; return r; }, // header checksum
      r => { r[19] ^= 1; return r; }, // payload checksum
      r => { r[5] ^= 1; r[18] ^= 1; return r; }, // valid checksum, wrong sequence
      r => { r[17]--; r[18] ^= 1; return r; }, // declared length shorter than reply
      r => { r[0]--; r[51] = 0xff; r[17]--; r[18] ^= 1; return r; }, // valid framing, short memory payload
      r => { r[9] = 1; r[18] ^= 1; return r; }, // memory error
    ];
    for (const fault of faults) {
      const { amp, fake } = setup();
      await amp.readBackup();
      const backup = amp.backup.slice(), flash = fake.flash.slice();
      fake.fault = fault; fake.ops = [];
      await assert.rejects(amp.writeSlot(3, WRITE_IMAGE));
      assert.deepEqual(fake.ops, [core.OP.READ_MEM]);
      assert.deepEqual(amp.backup, backup);
      assert.deepEqual(fake.flash, flash);
      assert.equal(amp.busy, false);
    }
  });

  fixtureTest('duplicate reports at pre-read, flash acknowledgement and read-back never verify a write', async () => {
    for (const phase of ['before', 'flash', 'after']) {
      const { amp, fake } = setup();
      await amp.readBackup();
      const backup = amp.backup.slice();
      if (phase === 'flash') {
        let duplicated = false;
        fake.fault = (r, command) => {
          if (!duplicated && command.op === core.OP.FLASH_FROM_USB) {
            duplicated = true;
            setTimeout(() => amp._onInput({ data: new DataView(r.slice().buffer) }), 0);
          }
          return r;
        };
      } else fake.duplicateRead = fake.reads + (phase === 'before' ? 32 : 64);
      fake.ops = [];
      await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /extra data/);
      assert.equal(fake.ops.filter(op => op === core.OP.FLASH_FROM_USB).length, phase === 'before' ? 0 : 1);
      assert.deepEqual(amp.backup, backup);
    }
  });

  fixtureTest('failed read-back never updates backup, even for bytes beyond the checksum span', async () => {
    for (const index of [0, 200, 1023]) {
      const { amp, fake } = setup();
      await amp.readBackup();
      const backup = amp.backup.slice();
      let corrupted = false;
      fake.fault = (r, command) => {
        if (command.op === core.OP.FLASH_FROM_USB && !corrupted) {
          fake.flash[0x1000 + index] ^= 1; corrupted = true;
        }
        return r;
      };
      await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /does not match/);
      assert.deepEqual(amp.backup, backup);
      assert.equal(fake.ops.filter(op => op === core.OP.FLASH_FROM_USB).length, 1);
    }
  });

  fixtureTest('an incomplete backup cannot unlock writes', async () => {
    const { amp, fake } = setup({ duplicateRead: 192 });
    await assert.rejects(amp.readBackup(), /extra data/);
    assert.equal(amp.backup, null);
    await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /Back up/);
    assert.ok(!fake.ops.includes(core.OP.FLASH_FROM_USB));
  });

  function virtualNavigator(t, devices) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const hid = {
      requestDevice: async options => {
        assert.deepEqual(options.filters, [{ vendorId: 0x9886, productId: 2, usagePage: 0xff31, usage: 0x74 }]);
        return devices;
      },
      addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hid } });
    t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; });
  }

  fixtureTest('WebHID connect verifies identity and reconnect requires a fresh backup', async t => {
    const { amp, fake } = setup();
    amp.device = null; amp.identity = null;
    virtualNavigator(t, [fake]);
    await amp.connect();
    assert.equal(fake.opened, true);
    assert.equal(amp.backup, null);
    await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /Back up/);
    await amp.readBackup();
    await amp.disconnect();
    assert.equal(amp.backup, null);
    assert.equal(amp.identity, null);
    assert.equal(fake.opened, false);
    assert.equal(fake.listeners.size, 0);
    await amp.connect();
    await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /Back up/);
    assert.ok(!fake.ops.includes(core.OP.FLASH_FROM_USB));
    await amp.disconnect();
  });

  fixtureTest('wrong USB identity, vendor interface, ambiguous selection or firmware cannot unlock writing', async t => {
    const { amp, fake } = setup();
    amp.device = null; amp.identity = null;
    const devices = [];
    virtualNavigator(t, devices);
    for (const props of [{ vendorId: 1 }, { productId: 3 }, { collections: [] }]) {
      const bad = Object.assign(new FakeHid(amp), props);
      devices.splice(0, devices.length, bad);
      await assert.rejects(amp.connect(), /No MixAmp/);
      assert.equal(bad.opened, false);
      assert.deepEqual(bad.ops, []);
    }
    devices.splice(0, devices.length, fake, new FakeHid(amp));
    await assert.rejects(amp.connect(), /More than one/);
    for (const version of [0x0d2d1005, 0x0d2e1006]) {
      const bad = new FakeHid(amp, { version });
      devices.splice(0, devices.length, bad);
      await assert.rejects(amp.connect(), /Unsupported device/);
      assert.equal(bad.opened, false);
      assert.equal(amp.identity, null);
      assert.equal(amp.backup, null);
      await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /verified MixAmp/);
      assert.deepEqual(bad.ops, [core.OP.VERSION]);
    }
  });

  fixtureTest('unplugging clears connection backup and prevents further writes', async t => {
    const { amp, fake } = setup();
    virtualNavigator(t, [fake]);
    await amp.readBackup();
    let unplugged = false;
    amp.onDisconnect = () => { unplugged = true; };
    amp._gone({ device: {} });
    assert.ok(amp.backup);
    amp._gone({ device: fake });
    assert.equal(unplugged, true);
    assert.equal(amp.backup, null);
    assert.equal(amp.connected, false);
    await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /verified MixAmp/);
    assert.ok(!fake.ops.includes(core.OP.FLASH_FROM_USB));
  });

  fixtureTest('malformed flash acknowledgements or read-back replies stop without retry or verification', async () => {
    for (const phase of ['flash', 'readback']) {
      const { amp, fake } = setup();
      await amp.readBackup();
      const backup = amp.backup.slice();
      let flashed = false;
      fake.fault = (r, command) => {
        if (command.op === core.OP.FLASH_FROM_USB) flashed = true;
        if ((phase === 'flash' && command.op === core.OP.FLASH_FROM_USB) ||
            (phase === 'readback' && flashed && command.op === core.OP.READ_MEM)) r[18] ^= 1;
        return r;
      };
      await assert.rejects(amp.writeSlot(3, WRITE_IMAGE), /checksum/);
      assert.deepEqual(amp.backup, backup);
      assert.equal(fake.ops.filter(op => op === core.OP.FLASH_FROM_USB).length, 1);
      assert.equal(amp.busy, false);
    }
  });

  }
}
