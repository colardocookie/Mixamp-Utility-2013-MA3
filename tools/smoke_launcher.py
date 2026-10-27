"""Exercise the running packaged executable from an unrelated working directory. No HID."""
import http.client
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from launcher import ASSETS


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory() as directory:
        log = Path(directory) / 'launcher.log'
        with log.open('w') as output:
            process = subprocess.Popen([str(executable), '--no-browser', '--port', '0'],
                                       cwd=directory, stdout=output, stderr=subprocess.STDOUT)
            try:
                port = None
                for _ in range(150):
                    text = log.read_text(errors='replace')
                    match = re.search(r'http://127\.0\.0\.1:(\d+)/', text)
                    if match:
                        port = int(match[1])
                        break
                    if process.poll() is not None:
                        raise RuntimeError(f'Launcher exited early:\n{text}')
                    time.sleep(0.2)
                if port is None:
                    raise RuntimeError(f'Launcher did not print its URL:\n{log.read_text()}')
                for name in ASSETS:
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                    try:
                        connection.request('GET', '/' + name)
                        response = connection.getresponse()
                        assert response.status == 200, (name, response.status)
                        assert response.read() == (ROOT / name).read_bytes(), name
                    finally:
                        connection.close()
                print('Packaged EXE starts outside the checkout and serves all public assets exactly.')
            finally:
                if sys.platform == 'win32':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], check=False)
                else:
                    process.terminate()
                process.wait(timeout=10)


if __name__ == '__main__':
    main()
