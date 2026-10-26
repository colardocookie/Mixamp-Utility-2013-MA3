"""Build the web utility's public target library. OFFLINE, no device IO, no headphone data.

Downloads over-ear target curves from the AutoEq repository (MIT licence) into data/targets/ and writes
data/targets.json: every target on a 241-point log grid (20 Hz - 20 kHz, normalised to 0 dB at 1 kHz),
plus Harman over-ear 2018 as measured on each rig. The web app uses those Harman curves to move a
target onto the rig of the user's headphone measurement:
  target_on_measurement_rig = target_native - Harman2018_on_target_rig + Harman2018_on_measurement_rig
Targets defined on rigs with no Harman 2018 reference here (B&K 5128) are listed as not convertible.

Usage (Python 3 with numpy): python tools/build_targets.py
"""
import csv
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

WEBAPP = Path(__file__).resolve().parents[1]
AUTOEQ_RAW = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/targets/'
TARGET_DIR = WEBAPP / 'data' / 'targets'
OUT = WEBAPP / 'data' / 'targets.json'
SMOOTH = 0.003                                         # band-fit smoothing used by the app (ma3-eq.js DEFAULT_SMOOTH)
GRID = [20 * 1000 ** (i / 240) for i in range(241)]   # same grid as ma3-core.js PEAK_GRID

# Harman over-ear 2018 as expressed on each rig (AutoEq files); used to move targets between rigs.
RIG_HARMAN = {
    'GRAS': 'Harman over-ear 2018',
    'Rtings HMS II.3 (legacy)': 'Rtings Harman over-ear 2018',
    'Innerfidelity': 'Innerfidelity Harman over-ear 2018',
    'Headphone.com Legacy': 'Headphone.com Legacy Harman over-ear 2018',
    'crinacle EARS + 711': 'crinacle EARS + 711 Harman over-ear 2018',
    'B&K 5128': None,
}

# (company, display name, AutoEq file, native rig, note)
LIBRARY = [
    ('Harman', 'Harman over-ear 2018', 'Harman over-ear 2018', 'GRAS', 'The current Harman headphone target (Olive & Welti).'),
    ('Harman', 'Harman over-ear 2018 without bass', 'Harman over-ear 2018 without bass', 'GRAS', 'Harman 2018 without its bass shelf.'),
    ('Harman', 'Harman over-ear 2015', 'Harman over-ear 2015', 'GRAS', 'Earlier Harman revision.'),
    ('Harman', 'Harman over-ear 2015 without bass', 'Harman over-ear 2015 without bass', 'GRAS', ''),
    ('Harman', 'Harman over-ear 2013', 'Harman over-ear 2013', 'GRAS', 'The original Harman headphone target.'),
    ('Harman', 'Harman over-ear 2013 without bass', 'Harman over-ear 2013 without bass', 'GRAS', ''),
    ('Rtings', 'Rtings target', 'Rtings original', 'Rtings HMS II.3 (legacy)', "Rtings' own reference curve."),
    ('Rtings', 'Rtings target with bass', 'Rtings original with bass', 'Rtings HMS II.3 (legacy)', ''),
    ('Rtings', 'Rtings average', 'Rtings orginal average', 'Rtings HMS II.3 (legacy)', 'Average response of headphones Rtings measured.'),
    ('SBAF', 'SBAF-Serious', 'Rtings SBAF-Serious', 'Rtings HMS II.3 (legacy)', 'Community target from Super Best Audio Friends.'),
    ('oratory1990', 'Optimum HiFi over-ear', 'oratory1990 optimum hifi over-ear', 'GRAS', "oratory1990's preference target."),
    ('Innerfidelity', 'Innerfidelity 2017', 'Innerfidelity 2017', 'Innerfidelity', "Tyll Hertsens' Innerfidelity compensation."),
    ('Innerfidelity', 'Innerfidelity 2016', 'Innerfidelity 2016', 'Innerfidelity', ''),
    ('Headphone.com', 'Headphone.com original', 'Headphone.com Legacy original', 'Headphone.com Legacy', 'Legacy Headphone.com compensation.'),
    ('Diffuse field', 'Diffuse field ISO 11904-1', 'Diffuse field ISO 11904-1', 'GRAS', 'Diffuse-field reference; rig match approximate.'),
    ('Diffuse field', 'Diffuse field GRAS KEMAR', 'Diffuse field GRAS KEMAR', 'GRAS', 'Diffuse field of the KEMAR head; rig match approximate.'),
    ('Diffuse field', 'Diffuse field 5128', 'Diffuse field 5128', 'B&K 5128', 'Needs a B&K 5128 measurement.'),
    ('Diffuse field', 'Diffuse field 5128 −1 dB/oct', 'Diffuse field 5128 -1dB per octave', 'B&K 5128', 'Needs a B&K 5128 measurement.'),
    ('LMG', 'LMG 5128 0.6', 'LMG 5128 0.6', 'B&K 5128', 'Needs a B&K 5128 measurement.'),
    ('LMG', 'LMG 5128 0.6 without bass', 'LMG 5128 0.6 without bass', 'B&K 5128', 'Needs a B&K 5128 measurement.'),
]
COMPANY_NOTES = {
    'Crinacle (IEF)': 'IEF targets are not openly licensed, so they are not bundled. Import an IEF target file you are allowed to use; '
                      'the utility moves it onto your headphone measurement and computes the EQ.',
}


def fetch(name):
    """Returns (frequency, dB) arrays of an AutoEq target, downloading it once into data/targets/."""
    path = TARGET_DIR / f'{name}.csv'
    if not path.exists():
        url = AUTOEQ_RAW + urllib.parse.quote(name) + '.csv'
        with urllib.request.urlopen(url, timeout=30) as r:
            path.write_bytes(r.read())
    rows = list(csv.DictReader(path.open(encoding='utf-8')))
    return np.array([float(r['frequency']) for r in rows]), np.array([float(r['raw']) for r in rows])


def on_grid(freq, values, grid):
    return np.interp(np.log(grid), np.log(freq), values)


def build_library():
    """Returns (library dict, [(entry, frequency, dB)]) for every target."""
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    rig_harman_grid = {rig: on_grid(*fetch(n), GRID) for rig, n in RIG_HARMAN.items() if n}
    companies, targets = {}, []
    for company, display, file, rig, note in LIBRARY:
        tf, tv = fetch(file)
        entry = dict(id=file, name=display, rig=rig, note=note, source='AutoEq targets (MIT)', convertible=bool(RIG_HARMAN.get(rig)),
                     curve=[round(float(v), 2) for v in on_grid(tf, tv, GRID) - on_grid(tf, tv, [1000])[0]])
        companies.setdefault(company, []).append(entry)
        targets.append((entry, tf, tv))
    library = dict(
        generatedBy='tools/build_targets.py',
        rigs={rig: [round(float(v), 2) for v in vals] for rig, vals in rig_harman_grid.items()},
        companies=[dict(name=c, note=COMPANY_NOTES.get(c, ''), targets=t) for c, t in companies.items()]
                  + [dict(name=c, note=n, targets=[]) for c, n in COMPANY_NOTES.items()],
        engine=dict(minMeanError=True, maxGainDb=6.0, smooth=SMOOTH),
    )
    return library, targets


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    library, _ = build_library()
    OUT.write_text(json.dumps(library, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {OUT} ({OUT.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
