// Checks the EQ maths against the real AutoEq engine and the Python fitter. The public target library is
// always tested; the comparisons with the real engine use the local headphone profile when it exists
// (data/local/headphones.json, built by tools/build_targets.py; not in the public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as eq from '../ma3-eq.js';
import * as core from '../ma3-core.js';
import { fixtureTest } from '../test-support/fixtures.js';

const lib = JSON.parse(readFileSync(new URL('../data/targets.json', import.meta.url), 'utf8'));
const localUrl = new URL('../data/local/headphones.json', import.meta.url);
const hp = existsSync(localUrl) ? JSON.parse(readFileSync(localUrl, 'utf8')).headphones[0] : null;
const localTest = (name, fn) => test(name, { skip: hp ? false : 'needs the local headphone profile (tools/build_targets.py)' }, fn);
const G = eq.GRID, inRange = G.map(f => f >= 20 && f <= 12000);
const targets = lib.companies.flatMap(c => c.targets);
const pts = arr => G.map((f, i) => [f, arr[i]]);

test('public target library: curves and rig references only, no headphone data', () => {
  assert.ok(targets.length >= 20);
  assert.ok(lib.companies.some(c => c.name === 'Crinacle (IEF)'));
  assert.equal(lib.headphone, undefined);
  for (const t of targets) {
    assert.equal(t.curve.length, G.length);
    assert.equal(t.alphaS, undefined);
    assert.equal(t.convertible, !!lib.rigs[t.rig]);
  }
  assert.ok(targets.filter(t => t.convertible).length >= 16);
  assert.ok(!JSON.stringify(lib).includes('HyperX'));
});

test('a target moved onto its own rig and corrected against itself needs no EQ', () => {
  const t = targets.find(x => x.id === 'Harman over-ear 2018');
  const moved = eq.targetForHeadphone(pts(t.curve), lib.rigs.GRAS, lib.rigs.GRAS);
  const corr = eq.autoEqCorrection(pts(moved), pts(moved));
  assert.ok(Math.max(...corr.filter((_, i) => inRange[i]).map(Math.abs)) < 0.01);
});

localTest('AutoEq port matches the real AutoEq engine on every bundled target', () => {
  for (const t of targets.filter(x => hp.presets[x.id])) {
    const moved = eq.targetForHeadphone(pts(t.curve), lib.rigs[t.rig], hp.harmanReference);
    const corr = eq.autoEqCorrection(pts(hp.raw), pts(moved));
    const d = corr.map((v, i) => v - hp.presets[t.id].correction[i]).filter((_, i) => inRange[i]);
    assert.ok(Math.max(...d.map(Math.abs)) < 0.2, `${t.name}: ${Math.max(...d.map(Math.abs))}`);
  }
});

localTest('band fitter matches the Python fitter within 0.5 dB per band', () => {
  for (const t of targets.filter(x => hp.presets[x.id]).slice(0, 6)) {
    const p = hp.presets[t.id];
    const fit = eq.fitBands(pts(p.correction));
    const diff = Math.max(...fit.gains.map((g, i) => Math.abs(g - p.gains[i])));
    assert.ok(diff <= 0.5, `${t.name}: ${diff}`);
    assert.ok(fit.rmsErrorDb < 1.5);
  }
  assert.deepEqual(hp.presets['Harman over-ear 2018'].gains, [2.8, -0.3, -0.6, -1.2, -3.0, -2.1, -0.6, 0.2, 1.7, 1.7, -3.0, 3.9, 0.1, -3.4]);
});

test('ParametricEQ / FixedBandEQ profiles parse and reproduce their filters', () => {
  const text = 'Preamp: -6.4 dB\nFilter 1: ON LSC Fc 105 Hz Gain 6.0 dB Q 0.70\nFilter 2: ON PK Fc 1000 Hz Gain -3.0 dB Q 1.41\nFilter 3: ON HSC Fc 10000 Hz Gain -2.0 dB Q 0.70\nFilter 4: OFF PK Fc 3000 Hz Gain 9 dB Q 1\n';
  const p = eq.parseAutoEqProfile(text);
  assert.equal(p.kind, 'ParametricEQ');
  const at = f => p.correction[G.findIndex(g => g >= f)];
  assert.ok(at(20) > 5 && at(20) < 6.5);
  assert.ok(at(1000) < -2.5 && at(1000) > -3.5);
  assert.ok(at(19000) < -1.5);
  assert.ok(Math.abs(at(3000)) < 1.5);        // the OFF filter is ignored
});

test('GraphicEQ and results-CSV profiles parse', () => {
  const g = eq.parseAutoEqProfile('GraphicEQ: 20 4.0; 100 -2.0; 1000 0.0; 4000 5.0; 20000 -4.0');
  assert.equal(g.kind, 'GraphicEQ');
  assert.ok(Math.abs(g.correction[G.findIndex(f => f >= 1000)]) < 0.2);
  const csv = 'frequency,raw,equalization\n20,1,3.5\n1000,0,0\n20000,0,-2\n';
  const c = eq.parseAutoEqProfile(csv);
  assert.equal(c.kind, 'AutoEq results CSV');
  assert.ok(Math.abs(c.correction[0] - 3.5) < 0.01);
  assert.throws(() => eq.parseAutoEqProfile('hello'), /Not an AutoEq profile/);
});

test('target files parse from CSV and squig.link / REW text, and short curves are rejected', () => {
  const csv = eq.parseTargetFile('frequency,raw\n20,5\n1000,0\n20000,-5\n' + Array.from({ length: 20 }, (_, i) => `${100 + i * 10},1`).join('\n'));
  assert.ok(csv.length > 10);
  const rew = eq.parseTargetFile('* REW export\n* Freq(Hz) SPL(dB)\n' + Array.from({ length: 40 }, (_, i) => `${(20 * 1.2 ** i).toFixed(2)}\t${(i / 10).toFixed(2)}\t0`).join('\n'));
  assert.ok(rew.length === 40);
  const short = '* squig\n' + Array.from({ length: 30 }, (_, i) => `${20 + i * 200} 1`).join('\n');
  assert.throws(() => eq.parseTargetFile(short), /only covers/);
});

fixtureTest('an imported profile becomes a slot image that passes the safety checks', () => {
  const p = eq.parseAutoEqProfile('Preamp: -6 dB\nFilter 1: ON LSC Fc 105 Hz Gain 8.0 dB Q 0.70\nFilter 2: ON PK Fc 3000 Hz Gain -4.0 dB Q 2\n');
  const fit = eq.fitBands(pts(p.correction));
  const image = core.customImage(3, fit.gains, -12, { gate: 'off', codecEq: 'off' });
  assert.deepEqual(core.checkSlotImage(3, image), []);
});
