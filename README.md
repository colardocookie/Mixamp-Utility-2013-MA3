# Mixamp-Utility-2013-MA3

A browser utility for the 2013 ASTRO MixAmp Pro (MA3; USB `9886:0002`, firmware 3374, model 1005). It edits the MixAmp's custom preset slots and writes them over USB with WebHID, in the style of the Wooting web utility. Nothing to install: it runs in Chrome or Edge.

> Unofficial. Not affiliated with or endorsed by ASTRO Gaming or Logitech. Writing to your device is at your own risk; see *How a write works* for the safety checks.

What it changes, per slot:
- the 14-band EQ curve (or the slot's exact factory curve), plus level;
- codec 5-band EQ on/off;
- mic noise gate: off, gentle noise reduction, factory, strong, or custom threshold, ratio and reduction.

It writes **only** the five 1 KB preset slots in data flash (`0x800400`–`0x801400`). The MixAmp firmware itself is never touched. A slot whose checksum fails makes the MixAmp load the factory preset, and "Restore slot to factory" uses that.

## Run it

WebHID needs Chrome or Edge, and a secure page (`http://localhost` or `https://` counts). Serve this folder with any static web server, for example:

```bash
python -m http.server 8765 --bind 127.0.0.1
```

Then open <http://localhost:8765> in Chrome or Edge, press **Connect MixAmp**, and pick the MixAmp in the browser's device chooser.

Close other software that talks to the MixAmp first (for example ASTRO's updater): only one program should use it at a time.

## How a write works

1. **Connect.** The utility checks the USB identity and the vendor interface, then reads the version. Anything other than firmware 3374 / model 1005 is refused.
2. **Automatic backup.** Straight after connecting, the utility reads the settings sector and all five slots (6 KB), plus the MixAmp's factory EQ tables (about 1 KB, checked against SHA-256 fingerprints), using 32-byte single-report reads. Everything stays in the page's memory: **nothing is saved to your computer** unless you press **Save backup file**. Writing stays locked until this connection's backup has been read.
3. **Edit a slot.** The checks run live:
   - the same startup simulation the MixAmp's loader performs;
   - only factory codec registers, changing at most the gate and codec-EQ enable bits;
   - stable filters;
   - no louder than the loudest factory preset (−3.99 dB).
4. **Write or overwrite.** Type the slot number once to confirm; it stays filled, so later changes to the same slot are one click. The button reads **Overwrite** when the slot already holds a preset; no factory restore is needed first. The utility then:
   - re-reads the slot and requires it to match what the page last read (if something outside the page changed it, nothing is written, the page shows the new contents, and the next press overwrites);
   - sends one flash write to that slot's sector;
   - reads the slot back and compares every byte.

   Any unexpected reply, extra report or mismatch stops it. Nothing is retried.
5. **Turn the MixAmp's selector to that slot** (or away and back if it is already selected). The MixAmp reloads a slot whenever it is selected. Then press **Check on MixAmp**.

Selector positions, shown by the four lights around the EQ button: top left = slot 1, top right = slot 2, bottom right = slot 3, bottom left = slot 4. Slot 0 has no position and is hidden.

## Target library

The editor has a library of over-ear target curves, grouped by who published them: Harman (2013, 2015 and 2018, each with and without bass), Rtings, SBAF, oratory1990, Innerfidelity, Headphone.com, diffuse field and LMG. Click a company to pick one of its targets, or use the **All targets** dropdown.

Targets are fitted to **your headphone**, so first add its measurement (see Import). Choosing a target then:
1. moves the target onto your measurement's rig, using the Harman 2018 curve on both rigs as the reference;
2. computes the correction with a JavaScript port of AutoEq (within 0.07 dB of the real engine on every bundled target, with `min_mean_error` and a +6 dB boost cap);
3. fits it to the MixAmp's 14 bands and matches preset C's loudness.

The chart shows the ideal correction as a dotted line, so you can see where the 14 fixed bands fall short. Targets defined on a B&K 5128 rig need a 5128 measurement and are disabled for other rigs.

## Import

- **Your headphone measurement:** a CSV with `frequency,raw` columns, plus the rig it was measured on. Best is the CSV from AutoEq's `results` folder: it also carries the Harman reference AutoEq used for that rig (the `target` column), so the fits reproduce AutoEq exactly. Imported headphones are remembered in this browser.
- **AutoEq profile (any headphone):** load or paste `ParametricEQ.txt`, `FixedBandEQ.txt`, `GraphicEQ.txt` or a results CSV made on [autoeq.app](https://autoeq.app). It's fitted to the 14 bands directly.
- **Target curve:** add a target that isn't in the library (CSV, or squig.link / REW text), for example a Crinacle IEF target you're allowed to use, with the rig it was measured on. It appears under **Imported** and is fitted to your headphone.

Crinacle's IEF targets aren't openly licensed, so they aren't bundled.

A local headphone profile can also be placed at `data/local/headphones.json` (not part of the repo). It has the same shape as an imported headphone, plus optional precomputed `presets` per target id; the app loads it automatically when the file exists.

## Microphone noise gate

Each slot carries the MixAmp's mic noise gate settings, which the MixAmp loads when the slot is selected. The gate is the WM8994 codec's downward expander on the mic path (datasheet pp. 73–79):

| Setting | Range |
|---|---|
| Threshold | −36 to −82.5 dB, 1.5 dB steps |
| Ratio | 2:1, 4:1 or 8:1 |
| Max reduction | 0 to −36 dB, 6 dB steps |

Modes: **Off**, **Gentle noise reduction** (−60 dB, 2:1, at most −12 dB: lowers steady background noise without chopping words), **Factory gate** (−54 dB, 4:1, −36 dB), **Strong gate** (−48 dB, 8:1, −36 dB), or **Custom**. Only the gate's own register fields may change; everything else in the mic compressor stays factory.

This is a level-based gate, not voice-aware noise suppression. The MixAmp's chips have no noise-suppression processing that can be enabled: noise louder than the threshold, or noise while you talk, still gets through. For real suppression, use software on the PC (for example NVIDIA Broadcast or an RNNoise-based filter).

## Develop

- `ma3-core.js`: image builder, loader simulator, safety checks and HID framing. A port of `ma3_preset_slot.py`.
- `ma3-device.js`: the WebHID transport and its safety rules.
- `app.js`, `index.html`, `app.css`: the UI.
- `ma3-eq.js`: the 14-band fitter, AutoEq profile and target parsers, and the AutoEq correction port.
- `factory-params.js`: table addresses, SHA-256 fingerprints and derived band parameters. No firmware bytes; the tables are read from the connected MixAmp.
- `test/fixtures/` (local only, gitignored): raw factory tables and golden images generated by `tools/export_data.py` from the research project's firmware dump. Tests that need them are skipped when they are missing.
- `data/targets.json` and `data/targets/`: generated by `tools/build_targets.py` (Python 3 with numpy): `python tools/build_targets.py`.

```bash
cd webapp && npm test
```

The tests check the public target library and, when the local profile is present, that the AutoEq port matches the real engine and the JavaScript fitter matches the Python one. They also check that the JavaScript builder reproduces the Python builder's slot images byte for byte. They also run the device layer against a fake MixAmp: backup, write, restore, stray-report, changed-slot, flash-error and read-back cases.

## Status

The slot format, flash write and reload behaviour were verified on a real 2013 MixAmp Pro with the research tools this utility is ported from (custom presets written, read back, and loaded at power-up and on preset change). The browser utility uses the same sequence and passes its offline test suite.

## Licence

MIT, see `LICENSE`. Target curves come from AutoEq (MIT); see `THIRD_PARTY_NOTICES.md`. No MixAmp firmware or firmware data is included: the factory tables are read from your own MixAmp when you connect.
