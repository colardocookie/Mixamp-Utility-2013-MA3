// WebHID transport for the MixAmp Pro (2013, firmware 3374). Same rules as the Python tools:
// exact identity + version check, one operation at a time, stray-report checks, single-report
// 32-byte memory reads, no retries, and slot writes only after a backup taken on this connection.
import * as core from './ma3-core.js';

const VENDOR_ID = 0x9886, PRODUCT_ID = 0x0002, USAGE_PAGE = 0xff31, USAGE = 0x74;
const REPLY_TIMEOUT_MS = 5000, STRAY_WINDOW_MS = 100;

export const webHidAvailable = () => typeof navigator !== 'undefined' && 'hid' in navigator && window.isSecureContext;

export class MixAmp {
  constructor(log) {
    this.log = log;
    this.device = null;
    this.queue = [];
    this.waiter = null;
    this.seq = 0;
    this.busy = false;
    this.identity = null;
    this.backup = null;           // Uint8Array(0x1800) read on this connection, updated after verified writes
    this.onDisconnect = null;
    this._input = e => this._onInput(e);
    this._gone = e => { if (e.device === this.device) this._lost(); };
  }

  get connected() { return !!this.device; }

  async connect() {
    const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: USAGE_PAGE, usage: USAGE }] });
    const matches = devices.filter(d => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID &&
      d.collections.some(c => c.usagePage === USAGE_PAGE && c.usage === USAGE));
    if (matches.length !== 1) throw new Error(matches.length ? 'More than one MixAmp interface was selected' : 'No MixAmp vendor interface was selected');
    const device = matches[0];
    if (!device.opened) await device.open();
    this.device = device;
    this.queue = [];
    this.backup = null;
    device.addEventListener('inputreport', this._input);
    navigator.hid.addEventListener('disconnect', this._gone);
    this.log('connected', { product: device.productName });
    try {
      const v = core.decodeVersion((await this._exchange(core.OP.VERSION, [0, 0, 0], 'version')).scalar);
      if (v.firmware !== core.EXPECTED_VERSION.firmware || v.model !== core.EXPECTED_VERSION.model) {
        throw new Error(`Unsupported device: firmware ${v.firmware}, model ${v.model.toString(16)} (this utility supports firmware 3374, model 1005 only)`);
      }
      this.identity = v;
      this.log('identity verified', { firmware: v.firmware, model: v.model.toString(16) });
      return v;
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }

  async disconnect() {
    const d = this.device;
    this._detach();
    if (d && d.opened) await d.close();
    this.log('disconnected');
  }

  _detach() {
    if (this.device) this.device.removeEventListener('inputreport', this._input);
    navigator.hid?.removeEventListener('disconnect', this._gone);
    this.device = null;
    this.identity = null;
    this.backup = null;
    if (this.waiter) { this.waiter.reject(new Error('MixAmp disconnected')); this.waiter = null; }
  }

  _lost() {
    this._detach();
    this.log('device unplugged');
    if (this.onDisconnect) this.onDisconnect();
  }

  _onInput(e) {
    const report = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
    if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.resolve(report); }
    else this.queue.push(report);
  }

  _next(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('No reply from the MixAmp (timed out)')); }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  async _strayCheck(when) {
    await new Promise(r => setTimeout(r, when === 'after' ? STRAY_WINDOW_MS : 0));
    if (this.queue.length) {
      const stray = this.queue.map(core.bytesToHex);
      this.queue = [];
      this.log('stray report', { when, reports: stray });
      throw new Error('Unexpected extra data from the MixAmp; stopped without retrying');
    }
  }

  async _exchange(op, args, label, payload) {
    if (!this.device) throw new Error('Not connected');
    await this._strayCheck('before');
    this.seq = (this.seq % 255) + 1;
    const seq = this.seq;
    const stream = core.commandStream(op, args, seq, payload);
    const reports = core.hidReports(stream);
    for (const r of reports) await this.device.sendReport(0, r);
    let reply = new Uint8Array(0), expected = null;
    while (expected === null || reply.length < expected) {
      const raw = await this._next(REPLY_TIMEOUT_MS);
      const n = raw[0];
      if (raw.length !== 64 || n < 1 || n > 63 || raw.subarray(1 + n).some(b => b !== 0xff)) throw new Error('Malformed HID report from the MixAmp');
      const merged = new Uint8Array(reply.length + n);
      merged.set(reply); merged.set(raw.subarray(1, 1 + n), reply.length);
      reply = merged;
      expected = core.expectedReplyLength(reply);
      if (expected !== null && reply.length > expected) throw new Error('Reply longer than its own length field; stopped');
    }
    const parsed = core.parseReply(reply, seq);
    this.log(label, { seq, error: parsed.error, scalar: '0x' + parsed.scalar.toString(16), bytes: parsed.payload.length });
    return parsed;
  }

  async _run(fn) {
    if (this.busy) throw new Error('Another operation is still running');
    if (!this.identity) throw new Error('Connect to a verified MixAmp first');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  // Only these ranges are ever read: the settings sector + five slots, and the two factory tables.
  static readAllowed(address, length) {
    const ranges = [{ address: core.BACKUP_CPU_RANGE[0], length: core.BACKUP_CPU_RANGE[1] - core.BACKUP_CPU_RANGE[0] }, ...core.FACTORY_TABLE_RANGES];
    return ranges.some(r => address >= r.address && address + length <= r.address + r.length);
  }

  async _readMemory(address, length) {
    if (!MixAmp.readAllowed(address, length)) throw new Error(`Refusing to read 0x${address.toString(16)}: outside the backup and factory-table ranges`);
    const out = new Uint8Array(length);
    for (let off = 0; off < length; off += core.READ_PIECE) {
      const n = Math.min(core.READ_PIECE, length - off);
      const r = await this._exchange(core.OP.READ_MEM, [address + off, n, 0], 'read memory');
      if (r.error !== 0 || r.payload.length !== n) throw new Error('Memory read failed');
      out.set(r.payload, off);
    }
    await this._strayCheck('after');
    return out;
  }

  readStatus() {
    return this._run(async () => {
      const sys = core.decodeSys((await this._exchange(core.OP.READ_SYS, [0x53797300, 0, 0], 'read settings')).payload);
      const codec = {};
      for (const reg of [core.GATE_REG, core.AIF2_EQ_REG]) {
        const r = await this._exchange(core.OP.READ_CODEC, [reg, 0, 0], `read codec 0x${reg.toString(16)}`);
        if (r.error !== 0 || r.scalar > 0xffff) throw new Error('Codec read failed');
        codec[reg] = r.scalar;
      }
      await this._strayCheck('after');
      return { ...sys, gateOn: !!(codec[core.GATE_REG] & core.GATE_NG_ENA), codecEqOn: !!(codec[core.AIF2_EQ_REG] & core.AIF2_EQ_ENA), codec };
    });
  }

  readBackup() {
    return this._run(async () => {
      const [start, end] = core.BACKUP_CPU_RANGE;
      this.log('backup started', { from: '0x' + start.toString(16), to: '0x' + end.toString(16) });
      const data = await this._readMemory(start, end - start);
      this.backup = data;
      this.log('backup kept in this page', { sha256: await core.sha256Hex(data) });
      return data;
    });
  }

  // Reads the factory preset tables from the MixAmp's own firmware and checks their fingerprints.
  readFactoryTables() {
    return this._run(async () => {
      const [codec, akm] = core.FACTORY_TABLE_RANGES;
      const codecBytes = await this._readMemory(codec.address, codec.length);
      const akmBytes = await this._readMemory(akm.address, akm.length);
      await core.setFactoryTables(codecBytes, akmBytes);
      this.log('factory tables read and verified', { bytes: codec.length + akm.length });
    });
  }

  slotFromBackup(slot) {
    if (!this.backup) return null;
    const off = core.slotCpuAddress(slot) - core.BACKUP_CPU_RANGE[0];
    return this.backup.slice(off, off + core.SLOT_SIZE);
  }

  // Pre-read must match this connection's backup; then one opcode-9 write; then byte-for-byte readback.
  writeSlot(slot, image, policy = {}) {
    return this._run(async () => {
      const expectedBefore = this.slotFromBackup(slot);
      if (!expectedBefore) throw new Error('Back up the MixAmp on this connection before writing');
      const stream = core.slotWriteStream(slot, image, 0, policy);   // validates address and image; seq set below
      const cpu = core.slotCpuAddress(slot);
      const before = await this._readMemory(cpu, core.SLOT_SIZE);
      if (!core.equalBytes(before, expectedBefore)) {
        // Changed outside this page: refresh the page's copy so the user sees what is there now, but do not write.
        this.backup.set(before, cpu - core.BACKUP_CPU_RANGE[0]);
        this.log('slot changed outside this page; re-read', { slot });
        throw new Error(`Slot ${slot} was changed outside this page, so nothing was written. The page has re-read it; check the comparison and press Overwrite again.`);
      }
      this.log('write started', { slot, flash: '0x' + core.slotFlashAddress(slot).toString(16), sha256: await core.sha256Hex(image) });
      const r = await this._exchange(core.OP.FLASH_FROM_USB, [core.slotFlashAddress(slot), core.SLOT_SIZE, 0], 'flash write', stream.subarray(18));
      if (r.error !== 0) throw new Error(`The MixAmp reported flash error 0x${r.error.toString(16)}; slot ${slot} may now be empty (factory preset loads)`);
      const after = await this._readMemory(cpu, core.SLOT_SIZE);
      if (!core.equalBytes(after, image)) throw new Error(`Read-back of slot ${slot} does not match; it will load the factory preset if its checksum fails`);
      this.backup.set(after, cpu - core.BACKUP_CPU_RANGE[0]);
      this.log('write verified', { slot });
      return after;
    });
  }

  readSlot(slot) {
    return this._run(() => this._readMemory(core.slotCpuAddress(slot), core.SLOT_SIZE));
  }
}
