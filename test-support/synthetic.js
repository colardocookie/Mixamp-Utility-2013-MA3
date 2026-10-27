// Invented test data, never device firmware. Load the unmodified source in an isolated
// module graph with test-only fingerprints; production imports keep the real fingerprints.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FACTORY_PARAMS } from '../factory-params.js';

const params = structuredClone(FACTORY_PARAMS);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// Unique arbitrary registers, plus the documented adjustable gate/EQ fields.
const pairs = [[0x440, 0x100], [0x441, 0x24], [0x442, 2 << 10],
  [0x444, 12 << 5], [0x580, 1],
  ...Array.from({ length: 41 }, (_, i) => [0x600 + i, i * 17])];
const codecArray = new Uint8Array(184);
const codecView = new DataView(codecArray.buffer);
pairs.forEach(([reg, value], i) => { codecView.setUint16(i * 4, reg); codecView.setUint16(i * 4 + 2, value); });
// Fifteen identity biquads, with a conservative -18.06 dB pregain.
const akmArray = new Uint8Array(243);
akmArray[0] = 0x08;
for (let i = 0; i < 15; i++) akmArray[(6 + i * 5 + 4) * 3] = 0x40;
for (const va of params.tables.codec.arrays) params.tableSha256[va] = digest(codecArray);
for (const va of params.tables.akm.arrays) params.tableSha256[va] = digest(akmArray);
export const codecBytes = Uint8Array.from([...codecArray, ...codecArray]);
export const akmBytes = Uint8Array.from([...akmArray, ...akmArray, ...akmArray]);
const paramsUrl = moduleUrl(`export const FACTORY_PARAMS = ${JSON.stringify(params)};`);
const coreUrl = moduleUrl(source('ma3-core.js').replace("'./factory-params.js'", JSON.stringify(paramsUrl)));
export const core = await import(coreUrl);
export const { MixAmp } = await import(moduleUrl(source('ma3-device.js').replace("'./ma3-core.js'", JSON.stringify(coreUrl))));
export async function loadTables() { await core.setFactoryTables(codecBytes, akmBytes); }
await loadTables();
export const tables = { codec: core.bytesToHex(codecBytes), akm: core.bytesToHex(akmBytes) };
// Not golden expectations: these images are inputs for transport tests only.
export const golden = { cases: [
  { imageHex: core.bytesToHex(core.customImage(3, Array(14).fill(1), -12, { gate: 'off', codecEq: 'off' })) },
  { kind: 'factoryClone', slot: 3, imageHex: core.bytesToHex(core.factoryCurveImage(3, { gate: 'off' })) },
] };
