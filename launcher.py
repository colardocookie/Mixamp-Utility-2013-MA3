"""Portable local launcher. USB access remains exclusively in the browser."""
import argparse
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import unquote, urlsplit
import webbrowser

# Explicit public assets only: never bundle/serve a checkout or user profiles.
ASSETS = (
    'index.html', 'app.css', 'app.js', 'ma3-core.js', 'ma3-device.js',
    'ma3-eq.js', 'factory-params.js', 'data/targets.json', 'LICENSE',
    'THIRD_PARTY_NOTICES.md',
)


def asset_root():
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS) / 'site'
    return Path(__file__).resolve().parent


def load_assets(root):
    return {name: (root / name).read_bytes() for name in ASSETS}


def make_server(assets, port=8765):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.serve_asset()

        def do_HEAD(self):
            self.serve_asset(head=True)

        def serve_asset(self, head=False):
            # Reject unrelated hostnames even if they resolve to loopback.
            expected = f'127.0.0.1:{self.server.server_port}'
            if self.headers.get('Host') != expected:
                self.send_error(403)
                return
            path = unquote(urlsplit(self.path).path).removeprefix('/')
            if path == '':
                path = 'index.html'
            if path not in assets:
                self.send_error(404)
                return
            content = assets[path]
            kind = {'.js': 'text/javascript', '.css': 'text/css',
                    '.html': 'text/html', '.json': 'application/json'}.get(
                        Path(path).suffix, 'text/plain')
            self.send_response(200)
            self.send_header('Content-Type', kind + '; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if not head:
                self.wfile.write(content)

    # Stable preferred origin preserves browser imports and HID permissions.
    # Never assume an occupied port belongs to this app.
    for candidate in ([0] if port == 0 else range(port, min(port + 30, 65536))):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', candidate), Handler)
            server.daemon_threads = True
            return server
        except OSError as exc:
            if exc.errno not in (errno.EADDRINUSE, errno.EACCES) and getattr(exc, 'winerror', None) not in (10048, 10013):
                raise
    raise OSError('No free local port. Close an older MixAmp launcher and try again.')


def open_browser(url):
    if sys.platform == 'win32':
        for relative in ('Microsoft/Edge/Application/msedge.exe',
                         'Google/Chrome/Application/chrome.exe'):
            for variable in ('ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'):
                base = os.environ.get(variable)
                if base and (executable := Path(base) / relative).is_file():
                    try:
                        subprocess.Popen([str(executable), url])
                        return
                    except OSError:
                        continue
    if not webbrowser.open(url):
        print('Automatic browser opening was unavailable. Copy the address into Edge or Chrome.')


def main():
    parser = argparse.ArgumentParser(description='Run the MixAmp Utility on this PC.')
    parser.add_argument('--no-browser', action='store_true', help='only display the local address')
    parser.add_argument('--port', type=int, default=8765, help='preferred local port (default: 8765)')
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('port must be between 0 and 65535')
    try:
        assets = load_assets(asset_root())
        with make_server(assets, args.port) as server:
            url = f'http://127.0.0.1:{server.server_port}/'
            print('\nMixAmp Utility - ASTRO MixAmp Pro (2013 MA3)\n', flush=True)
            print(f'Open in Microsoft Edge or Google Chrome:\n\n  {url}\n', flush=True)
            print('Keep this window open while using the app. Close it or press Ctrl+C to stop.', flush=True)
            print('In the browser, press Connect MixAmp and select your device.', flush=True)
            if server.server_port != 8765:
                print('Using an alternate port; saved browser imports may be on the original address.', flush=True)
            if not args.no_browser:
                try:
                    open_browser(url)
                except Exception as exc:
                    print(f'Could not open the browser ({exc}). Open the address above manually.', flush=True)
            server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f'\nCould not start MixAmp Utility: {exc}', file=sys.stderr, flush=True)
        if getattr(sys, 'frozen', False):
            input('Press Enter to close...')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
