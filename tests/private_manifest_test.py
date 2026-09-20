"""Real Edge manifest/installability audit with a synthetic localhost session.

An HTTP-only cookie gates every app resource. A test-only session endpoint sets
that cookie; no real provider or account is contacted. The positive case serves
the unmodified repository HTML. A negative control omits the manifest link's
crossorigin attribute only in the local HTTP response, without changing files.
"""
import argparse
from functools import partial
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import tempfile
import threading
import time
import traceback
from urllib.parse import urlsplit, urlunsplit

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'


def clean_url(value):
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))


class State:
    def __init__(self):
        self.secret = secrets.token_urlsafe(32)
        self.requests = []
        self.omit_credentials_attribute = False
        self.lock = threading.Lock()

    def record(self, path, supplied, allowed):
        with self.lock:
            self.requests.append({'path':path, 'session_cookie_supplied':supplied,
                                  'authorized':allowed})

    def manifest_requests(self, since=0):
        with self.lock:
            return [dict(item) for item in self.requests[since:] if item['path'] == '/manifest.webmanifest']

    def offset(self):
        with self.lock:
            return len(self.requests)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, state, **kwargs):
        self.state = state
        super().__init__(*args, directory=str(ROOT / 'public'), **kwargs)

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/test-session':
            self.send_response(302)
            self.send_header('Set-Cookie', f'nebo_test_session={self.state.secret}; HttpOnly; SameSite=Lax; Path=/')
            self.send_header('Location', '/')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        cookies = SimpleCookie()
        cookies.load(self.headers.get('Cookie', ''))
        supplied = 'nebo_test_session' in cookies
        allowed = supplied and secrets.compare_digest(cookies['nebo_test_session'].value, self.state.secret)
        self.state.record(path, supplied, allowed)
        if not allowed:
            data = b'<!doctype html><title>Synthetic session required</title>Unauthorized test session'
            self.send_response(401)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path in ('/', '/index.html') and self.state.omit_credentials_attribute:
            data = (ROOT / 'public/index.html').read_bytes().replace(b' crossorigin="use-credentials"', b'')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()


def ready(page):
    expect(page.locator('body')).to_have_attribute('data-access', 'granted', timeout=45000)
    expect(page.locator('body')).to_have_attribute('data-worker-ready', 'true', timeout=45000)
    assert page.evaluate('() => window.isSecureContext && Boolean(navigator.serviceWorker.controller)')


def run(report):
    state = State()
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, state=state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f'http://127.0.0.1:{server.server_port}'
    report['local_origin'] = base_url
    def passed(label, **details):
        report['checks'].append({'test':label, 'passed':True, **details})
        print('PASS ' + label, flush=True)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=EDGE, headless=True)
            anonymous = browser.new_context(service_workers='allow')
            assert anonymous.cookies() == []
            assert anonymous.request.get(base_url + '/manifest.webmanifest').status == 401
            assert anonymous.request.get(base_url + '/assets/nebo-symbol.svg').status == 401
            passed('Anonymous manifest and install icon are protected by the synthetic HTTP-only session gate')
            anonymous.close()

            start = state.offset()
            # Playwright new_context() is incognito, which is intentionally not
            # installable. A disposable persistent profile exercises regular PWA
            # installability without accessing any real user's browser profile.
            profile = tempfile.TemporaryDirectory(prefix='nebo-manifest-test-')
            profile_path = Path(profile.name).resolve()
            assert profile_path.parent == Path(tempfile.gettempdir()).resolve()
            assert profile_path.name.startswith('nebo-manifest-test-')
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile_path), executable_path=EDGE,
                headless=True, service_workers='allow')
            page = context.new_page()
            page.on('pageerror', lambda error: report['page_error_types'].append(type(error).__name__))
            page.goto(base_url + '/test-session', wait_until='domcontentloaded')
            ready(page)
            cookies = context.cookies([base_url])
            assert len(cookies) == 1 and cookies[0]['httpOnly'] is True
            assert page.evaluate('() => document.cookie') == ''
            assert page.locator('link[rel="manifest"]').get_attribute('crossorigin') == 'use-credentials'
            passed('The real page starts with an HTTP-only session and a use-credentials manifest link', cookie_visible_to_page_javascript=False)

            cdp = context.new_cdp_session(page)
            manifest = cdp.send('Page.getAppManifest')
            assert manifest.get('errors', []) == [], 'CDP reported manifest parsing/fetch errors'
            parsed = json.loads(manifest['data'])
            assert parsed['display'] == 'standalone'
            assert parsed['name'] == 'NEBO AI - SECURITY'
            assert parsed['start_url'] == './' and parsed['scope'] == './'
            requests = state.manifest_requests(start)
            assert requests and all(request['session_cookie_supplied'] and request['authorized'] for request in requests)
            passed('Browser manifest request includes the session cookie and CDP parses the protected standalone manifest',
                   manifest_url=clean_url(manifest['url']), manifest_requests=len(requests),
                   every_manifest_request_authenticated=True, display=parsed['display'], parser_error_count=0)
            installability = cdp.send('Page.getInstallabilityErrors')
            error_ids = [error['errorId'] for error in installability.get('installabilityErrors', [])]
            report['positive_installability_error_ids'] = error_ids
            assert error_ids == [], 'CDP installability checks reported errors'
            passed('CDP installability audit reports zero errors for the authenticated page', installability_error_count=0)
            cdp.detach()
            context.close()
            profile.cleanup()

            # This response-only negative control proves the attribute is relevant:
            # the page/session remains authorized but the manifest omits cookies.
            state.omit_credentials_attribute = True
            start = state.offset()
            context = browser.new_context(service_workers='allow')
            page = context.new_page()
            page.goto(base_url + '/test-session', wait_until='domcontentloaded')
            ready(page)
            assert page.locator('link[rel="manifest"]').get_attribute('crossorigin') is None
            cdp = context.new_cdp_session(page)
            negative = cdp.send('Page.getAppManifest')
            requests = state.manifest_requests(start)
            assert requests and any(not request['session_cookie_supplied'] and not request['authorized'] for request in requests)
            assert not negative.get('data'), 'Cookie-gated manifest must not be available without credentials'
            passed('Negative control without crossorigin omits the cookie and cannot load the protected manifest',
                   manifest_denied_without_cookie=True, repository_files_modified=False)
            cdp.detach()
            context.close()
            assert not report['page_error_types'], report['page_error_types']
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=ROOT / 'tests/PRIVATE_MANIFEST_REPORT.json')
    args = parser.parse_args()
    report = {'status':'RUNNING', 'checks':[], 'page_error_types':[],
              'browser':'Microsoft Edge', 'service_workers':'allow',
              'positive_case_uses_fresh_temporary_persistent_profile':True,
              'synthetic_local_session_only':True, 'real_provider_or_cookies_used':False,
              'cookie_values_logged':False, 'application_sources_modified':False,
              'focus_revalidation_scope':'Not retested here; the earlier bootstrap report predates the focus listener addition.'}
    started = time.monotonic()
    try:
        run(report)
        report['status'] = 'PASS'
    except Exception as exc:
        report['status'] = 'FAIL'
        report['failure_type'] = type(exc).__name__
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        report['failure_location'] = {'file':Path(frame.filename).name, 'line':frame.lineno, 'function':frame.name}
        if type(exc) is AssertionError:
            report['failure'] = str(exc)
    finally:
        report['seconds'] = round(time.monotonic() - started, 3)
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8', newline='\n')
        print(json.dumps({'status':report['status'], 'checks':len(report['checks']),
                          'failure_type':report.get('failure_type'), 'seconds':report['seconds']}), flush=True)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
