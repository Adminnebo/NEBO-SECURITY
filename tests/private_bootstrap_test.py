"""Controlled HTTP audit of the private bootstrap with real Edge/SW execution.

The local server deliberately exposes static HTML/assets in every test state,
simulating a cached index. Only access-check.json changes its authorization
response. This tests fail-closed client startup, not the hosting provider's
authentication boundary. No real accounts, identities or user files are used.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
VALID = {'format':'NEBO-HOST-ACCESS-V1', 'version':10}
RESPONSES = {
    'denied_401': (401, 'application/json', VALID),
    'denied_403': (403, 'application/json', VALID),
    'html_login_200': (200, 'text/html', '<!doctype html><title>Sign in required</title>Sign in with a test provider'),
    'wrong_format': (200, 'application/json', {'format':'WRONG-ACCESS', 'version':10}),
    'wrong_version': (200, 'application/json', {'format':'NEBO-HOST-ACCESS-V1', 'version':9}),
    'malformed_json': (200, 'application/json', '{'),
    'redirect_login': (302, 'text/plain', 'Authentication redirect'),
    'allowed': (200, 'application/json', VALID),
}
INSTRUMENT = """(() => {
  const load = Number(sessionStorage.getItem('qa-bootstrap-loads') || '0') + 1;
  sessionStorage.setItem('qa-bootstrap-loads', String(load));
  window.__qaWorkers = {created: 0, terminated: 0};
  const OriginalWorker = window.Worker;
  window.Worker = new Proxy(OriginalWorker, {construct(Target, args, NewTarget) {
    const worker = Reflect.construct(Target, args, NewTarget);
    window.__qaWorkers.created++;
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {window.__qaWorkers.terminated++; return terminate();};
    return worker;
  }});
  window.addEventListener('nebo:access-locked', () => {
    sessionStorage.setItem('qa-access-locks', String(Number(sessionStorage.getItem('qa-access-locks') || '0') + 1));
    queueMicrotask(() => {
      sessionStorage.setItem('qa-workers-terminated', String(window.__qaWorkers.terminated));
      sessionStorage.setItem('qa-secrets-cleared', String(!document.getElementById('recoverySecret')?.value && !document.getElementById('receivedSecret')?.value));
    });
  });
})()"""


class ServerState:
    def __init__(self):
        self.mode = 'denied_401'
        self.requests = []
        self.lock = threading.Lock()

    def set_mode(self, mode):
        with self.lock:
            self.mode = mode

    def record(self, path):
        with self.lock:
            self.requests.append({'path':path, 'mode':self.mode})
            return self.mode

    def count(self, path):
        with self.lock:
            return sum(request['path'] == path for request in self.requests)


class TestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, state, **kwargs):
        self.test_state = state
        super().__init__(*args, directory=str(ROOT / 'public'), **kwargs)

    def log_message(self, *args):
        pass  # Query nonces and browser-generated request details are not logged.

    def end_headers(self):
        path = urlsplit(self.path).path
        self.send_header('Cache-Control', 'no-store' if path == '/access-check.json' else 'public, max-age=3600')
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        mode = self.test_state.record(path)
        if path == '/access-check.json':
            status, content_type, payload = RESPONSES[mode]
            data = (json.dumps(payload) if isinstance(payload, dict) else payload).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            if mode == 'redirect_login':
                self.send_header('Location', '/test-provider-login')
            self.end_headers()
            self.wfile.write(data)
        elif path == '/test-provider-login':
            data = b'<!doctype html><title>Sign in required</title>Test provider login'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            super().do_GET()


def new_page(browser, report):
    context = browser.new_context(service_workers='allow', viewport={'width':1440, 'height':1050})
    context.add_init_script(INSTRUMENT)
    page = context.new_page()
    # Exception types only: browser error messages can contain user input.
    page.on('pageerror', lambda error: report['page_error_types'].append(type(error).__name__))
    return context, page


def wait_allowed(page):
    expect(page.locator('body')).to_have_attribute('data-access', 'granted', timeout=45000)
    expect(page.locator('body')).to_have_attribute('data-worker-ready', 'true', timeout=45000)
    expect(page.locator('main')).to_be_visible()
    assert page.evaluate("() => Boolean(window.ASTRA_READY) && !document.querySelector('main').inert")
    assert page.evaluate("() => window.__qaWorkers.created") == 2


def wait_denied(page):
    expect(page.locator('body')).to_have_attribute('data-access', 'denied', timeout=30000)
    expect(page.locator('main')).not_to_be_visible()
    expect(page.locator('#mobileDock')).not_to_be_visible()
    expect(page.locator('#accessGate')).to_be_visible()
    assert page.evaluate("() => document.querySelector('main').inert")
    assert page.evaluate("() => typeof window.ASTRA_READY === 'undefined'")
    assert page.evaluate("() => window.__qaWorkers.created") == 0


def blob_bytes(page, selector):
    return bytes(page.locator(selector).evaluate("async link => Array.from(new Uint8Array(await (await fetch(link.href)).arrayBuffer()))"))


def assert_revoked(page, state, before_app, before_loads):
    wait_denied(page)
    assert state.count('/app.js') == before_app, 'Revoked reload must not import app.js'
    assert page.evaluate("() => Number(sessionStorage.getItem('qa-bootstrap-loads'))") > before_loads
    assert page.evaluate("() => Number(sessionStorage.getItem('qa-access-locks'))") == 1
    assert page.evaluate("() => Number(sessionStorage.getItem('qa-workers-terminated'))") == 2
    assert page.evaluate("() => sessionStorage.getItem('qa-secrets-cleared')") == 'true'
    page.reload(wait_until='domcontentloaded')
    wait_denied(page)
    assert state.count('/app.js') == before_app, 'Warm cached assets must not reopen the revoked application'


def run(report):
    state = ServerState()
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(TestHandler, state=state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}'
    report['local_origin'] = url
    def passed(name, **details):
        report['checks'].append({'test':name, 'passed':True, **details})
        print('PASS ' + name, flush=True)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=EDGE, headless=True)
            for mode in ('denied_401', 'denied_403', 'html_login_200', 'wrong_format', 'wrong_version', 'malformed_json', 'redirect_login'):
                state.set_mode(mode)
                context, page = new_page(browser, report)
                before_app = state.count('/app.js')
                before_probe = state.count('/access-check.json')
                page.goto(url, wait_until='domcontentloaded')
                wait_denied(page)
                assert state.count('/access-check.json') == before_probe + 1
                assert state.count('/app.js') == before_app
                assert page.evaluate("() => sessionStorage.getItem('qa-access-locks')") is None
                passed('Startup denial: ' + mode, main_hidden=True, app_imported=False, codec_workers_created=0)
                context.close()

            state.set_mode('allowed')
            context, page = new_page(browser, report)
            page.goto(url, wait_until='domcontentloaded')
            wait_allowed(page)
            controller = page.evaluate("() => new URL(navigator.serviceWorker.controller.scriptURL).pathname")
            assert controller == '/sw.js'
            passed('Valid JSON grants startup, imports app and starts both codec workers with active service worker', codec_workers_created=2)

            original = 'Synthetic private bootstrap test: caf\u00e9, \u5b89\u5168.\nExact bytes.'.encode('utf-8')
            page.locator('#sourceFile').set_input_files({'name':'bootstrap-test.txt', 'mimeType':'text/plain', 'buffer':original})
            before_probe = state.count('/access-check.json')
            page.locator('#encodeButton').click()
            page.locator('#senderResult:not(.hidden)').wait_for(timeout=120000)
            assert state.count('/access-check.json') > before_probe
            art = blob_bytes(page, '#downloadArt')
            secret = page.locator('#recoverySecret').input_value()
            assert len(secret) == 43
            passed('Encode performs a new authorization probe before producing a private PNG', new_probes=state.count('/access-check.json') - before_probe)

            page.locator('#receiverTab').click()
            page.locator('#receivedArt').set_input_files({'name':'private.png', 'mimeType':'image/png', 'buffer':art})
            expect(page.locator('#receivedPreview')).to_be_visible()
            page.locator('#receivedSecret').fill(secret)
            before_probe = state.count('/access-check.json')
            page.locator('#decodeButton').click()
            page.locator('#receiverResult:not(.hidden)').wait_for(timeout=120000)
            assert state.count('/access-check.json') > before_probe
            assert blob_bytes(page, '#downloadRestored') == original
            passed('Decode performs a new authorization probe and restores exact original bytes', new_probes=state.count('/access-check.json') - before_probe, exact_byte_recovery=True)

            page.locator('#senderTab').click()
            before_app = state.count('/app.js')
            before_loads = page.evaluate("() => Number(sessionStorage.getItem('qa-bootstrap-loads'))")
            state.set_mode('denied_401')
            with page.expect_navigation(wait_until='domcontentloaded', timeout=30000):
                page.locator('#encodeButton').click()
            assert_revoked(page, state, before_app, before_loads)
            passed('Authorization revoked before encode locks, terminates workers, clears secrets and reloads without cached reopening', revoke_status=401, worker_terminations=2, reload_stays_denied=True)
            context.close()

            state.set_mode('allowed')
            context, page = new_page(browser, report)
            page.goto(url, wait_until='domcontentloaded')
            wait_allowed(page)
            before_app = state.count('/app.js')
            before_loads = page.evaluate("() => Number(sessionStorage.getItem('qa-bootstrap-loads'))")
            before_probe = state.count('/access-check.json')
            state.set_mode('denied_403')
            # Actual elapsed time satisfies the production 15s revalidation guard.
            # Headless tabs do not consistently change document.hidden, so send
            # the production visibility event while the document is visible.
            page.wait_for_timeout(15500)
            assert page.evaluate('() => !document.hidden')
            with page.expect_navigation(wait_until='domcontentloaded', timeout=30000):
                page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
            assert state.count('/access-check.json') > before_probe
            assert_revoked(page, state, before_app, before_loads)
            passed('Returning visible after 15s revalidates, locks revoked access and reloads without cached reopening', revoke_status=403, synthetic_visibility_event=True, actual_elapsed_guard_ms=15500)
            context.close()
            assert not report['page_error_types'], report['page_error_types']
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=ROOT / 'tests/PRIVATE_BOOTSTRAP_REPORT.json')
    args = parser.parse_args()
    started = time.monotonic()
    report = {'status':'RUNNING', 'checks':[], 'page_error_types':[],
              'browser':'Microsoft Edge', 'service_workers':'allow',
              'synthetic_authorization_server':True, 'static_assets_available_even_when_denied':True,
              'static_http_cache_max_age_seconds':3600, 'private_cache_and_identity_tests_delegated':True,
              'logs_secrets_or_authentication_values':False}
    try:
        run(report)
        report['status'] = 'PASS'
    except Exception as exc:
        report['status'] = 'FAIL'
        report['failure_type'] = type(exc).__name__
        # Assertions in this test contain only fixed diagnostic text.
        if type(exc) is AssertionError:
            report['failure'] = str(exc)
    finally:
        report['seconds'] = round(time.monotonic() - started, 3)
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'status':report['status'], 'checks':len(report['checks']),
                          'failure_type':report.get('failure_type'), 'seconds':report['seconds']}), flush=True)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
