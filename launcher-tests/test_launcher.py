import http.client
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import launcher
from tools.build_windows import stage_assets


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.assets = launcher.load_assets(ROOT)
        self.server = launcher.make_server(self.assets, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, method='GET', host=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        try:
            connection.request(method, path, headers={} if host is None else {'Host': host})
            response = connection.getresponse()
            return response.status, response.getheaders(), response.read()
        finally:
            connection.close()

    def test_public_assets_and_modules_are_served_exactly(self):
        self.assertEqual(self.server.server_address[0], '127.0.0.1')
        for path, expected in self.assets.items():
            status, headers, body = self.request('/' + path)
            self.assertEqual(status, 200, path)
            self.assertEqual(body, expected, path)
        status, headers, body = self.request('/app.js', 'HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assertEqual(dict(headers)['Content-Type'], 'text/javascript; charset=utf-8')
        self.assertEqual(self.request('/')[2], self.assets['index.html'])

    def test_no_checkout_private_files_directories_or_writes(self):
        for path in ('/.git/config', '/test/fixtures/golden.json', '/data/local/headphones.json',
                     '/test-support/synthetic.js', '/../launcher.py', '/%2e%2e/launcher.py',
                     '/data/', '//launcher.py'):
            self.assertEqual(self.request(path)[0], 404, path)
        self.assertEqual(self.request('/', method='POST')[0], 501)
        self.assertEqual(self.request('/', host='example.com')[0], 403)

    def test_occupied_port_falls_back_to_its_own_listener(self):
        other = launcher.make_server(self.assets, self.server.server_port)
        try:
            self.assertNotEqual(other.server_port, self.server.server_port)
            self.assertEqual(other.server_address[0], '127.0.0.1')
        finally:
            other.server_close()

    def test_staging_includes_only_explicit_public_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'site'
            destination.mkdir()
            (destination / 'private.txt').write_text('must not survive a rebuild')
            stage_assets(destination)
            actual = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}
            self.assertEqual(actual, set(launcher.ASSETS))
            for name in actual:
                self.assertEqual((destination / name).read_bytes(), self.assets[name])

    def test_browser_launch_prefers_supported_browser_without_shell(self):
        with patch.object(launcher.sys, 'platform', 'win32'), \
             patch.dict(launcher.os.environ, {'ProgramFiles': 'C:/Programs'}, clear=True), \
             patch.object(Path, 'is_file', return_value=True), \
             patch.object(launcher.subprocess, 'Popen') as start:
            launcher.open_browser('http://127.0.0.1:8765/')
            self.assertEqual(start.call_args.args[0][-1], 'http://127.0.0.1:8765/')
            self.assertIn('msedge.exe', start.call_args.args[0][0])
            self.assertNotIn('shell', start.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
