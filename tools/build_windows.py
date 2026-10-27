"""Build on Windows with Python 3.12 + PyInstaller; no developer tools needed by users."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from launcher import ASSETS


def stage_assets(destination):
    if destination.exists():
        shutil.rmtree(destination)
    for name in ASSETS:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)


def main():
    if sys.platform != 'win32':
        raise SystemExit('Build the Windows executable on Windows (or use GitHub Actions).')
    stage = ROOT / 'build' / 'site'
    stage_assets(stage)
    subprocess.run([
        sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile',
        '--console', '--noupx', '--name', 'MixAmp-Utility',
        '--distpath', str(ROOT / 'dist'), '--workpath', str(ROOT / 'build' / 'pyinstaller'),
        '--specpath', str(ROOT / 'build'), '--add-data', f'{stage}:site',
        str(ROOT / 'launcher.py'),
    ], check=True, cwd=ROOT)
    exe = ROOT / 'dist' / 'MixAmp-Utility.exe'
    digest = hashlib.sha256(exe.read_bytes()).hexdigest()
    (exe.parent / 'SHA256SUMS.txt').write_text(f'{digest}  {exe.name}\n', encoding='utf-8')
    for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
        shutil.copyfile(ROOT / name, exe.parent / name)
    # Python's license accompanies the bundled runtime.
    python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    shutil.copyfile(python_license, exe.parent / 'PYTHON_LICENSE.txt')
    print(f'Built {exe}')


if __name__ == '__main__':
    main()
