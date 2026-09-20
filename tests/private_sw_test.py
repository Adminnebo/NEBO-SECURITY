"""Private PWA regression with a real v9 worker and a local hosting-gate stub.

The test gate is deliberately local; it is not an invented provider API.
"""
from collections import Counter
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
GIT = 'C:/Program Files/Git/cmd/git.exe'
REPORT = ROOT / 'tests/PRIVATE_SW_REPORT.json'
PROBE = b'''<!doctype html><html lang="es"><title>Local test harness</title>
<button id="installShortcut">Instalar</button><button id="installApp">Instalar</button>
<details><summary>Ayuda</summary><p id="installStatus"></p></details>
<p id="offlineStatus"></p></html>'''


class HostingGate(SimpleHTTPRequestHandler):
    mode = 200
    legacy = True
    requests = Counter()
    legacy_files = {}

    def log_message(self, *args):
        pass

    def reply(self, status, data, content_type='text/html; charset=utf-8', location=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        if location:
            self.send_header('Location', location)
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        # Deliberately cacheable server assets challenge the worker's no-store
        # policy. Private gate replies additionally carry no-store above.
        self.send_header('Cache-Control', 'max-age=3600')
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        type(self).requests[path] += 1
        try:
            if path == '/__probe__.html':
                self.reply(200, PROBE)
            elif path == '/__login__.html':
                self.reply(200, b'<!doctype html><title>Local login stub</title><h1>LOGIN STUB</h1>')
            elif self.mode == 302:
                self.reply(302, b'', location='/__login__.html')
            elif self.mode != 200:
                self.reply(self.mode, b'<!doctype html><title>Access denied</title><h1>DENIED BY TEST GATE</h1>')
            elif self.legacy and path in self.legacy_files:
                self.reply(200, self.legacy_files[path], self.guess_type(path if path != '/' else '/index.html'))
            else:
                super().do_GET()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass


def run():
    checks = []
    report = {'status': 'RUNNING', 'checks': checks, 'server': 'local hosting access-gate stub',
              'browser': 'Microsoft Edge, automated desktop', 'private_version': 10,
              'real_browser_restart': False, 'profile_deleted': False}
    started = time.monotonic()

    def passed(name, **details):
        checks.append({'test': name, 'passed': True, **details})
        print('PASS ' + name, flush=True)

    for filename in ('sw.js', 'index.html', 'app.js', 'install.js'):
        HostingGate.legacy_files['/' + filename] = subprocess.check_output(
            [GIT, 'show', f'version-9-png-token-integrado:public/{filename}'], cwd=ROOT)
    HostingGate.legacy_files['/'] = HostingGate.legacy_files['/index.html']
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(HostingGate, directory=str(ROOT/'public')))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}/'
    try:
        with tempfile.TemporaryDirectory(prefix='nebo-private-sw-', dir=ROOT/'tests') as profile:
            profile_path = Path(profile).resolve()
            assert profile_path.parent == (ROOT/'tests').resolve()
            assert profile_path.name.startswith('nebo-private-sw-')
            with sync_playwright() as pw:
                context = pw.chromium.launch_persistent_context(profile, executable_path=EDGE, headless=True)
                try:
                    page = context.new_page()
                    HostingGate.mode = 401
                    assert page.goto(base).status == 401
                    assert page.locator('#sourceFile').count() == 0
                    assert context.request.get(base+'app.js').status == 401
                    passed('A fresh anonymous visitor cannot fetch the application or its JavaScript')

                    HostingGate.mode = 200
                    page.goto(base+'__probe__.html')
                    identity = page.evaluate('''async () => {
                      const module = await import('./identity-store.js');
                      const identity = await module.createIdentity();
                      const contacts = await import('./contact-store.js');
                      await contacts.saveContact('Prueba conservada', identity.publicBundle);
                      for (const name of ['other-application-cache', 'nebo-app-v9-backup', 'nebo-app-v8']) {
                        const cache = await caches.open(name);
                        await cache.put('./sentinel', new Response('keep'));
                      }
                      await navigator.serviceWorker.register('./sw.js', {scope:'./', updateViaCache:'none'});
                      await navigator.serviceWorker.ready;
                      return identity.publicBundle.fingerprint;
                    }''')
                    page.wait_for_function("async () => (await caches.open('nebo-app-v9')).keys().then(keys => keys.length === 20)")
                    passed('The real v9 worker installs its complete 20-resource cache')

                    # Demonstrate the prior worker's real offline behavior first.
                    context.set_offline(True)
                    old_page = context.new_page()
                    assert old_page.goto(base, wait_until='domcontentloaded').status == 200
                    assert old_page.locator('#sourceFile').count() == 1
                    old_page.close()
                    context.set_offline(False)
                    passed('The legacy cached application is reproducibly available offline before migration')

                    HostingGate.legacy = False
                    page.evaluate("async () => navigator.serviceWorker.register('./sw.js?v=10', {scope:'./', updateViaCache:'none'}).then(() => true)")
                    page.wait_for_function("() => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js?v=10')")
                    caches_after = page.evaluate('() => caches.keys()')
                    assert sorted(caches_after) == ['nebo-app-v9-backup', 'other-application-cache'], caches_after
                    assert page.evaluate("async () => (await navigator.serviceWorker.getRegistration()).waiting === null")
                    passed('v10 takes control immediately and removes only caches matching nebo-app-vN', caches=caches_after)

                    preserved = page.evaluate('''async () => {
                      const identity = await (await import('./identity-store.js')).loadIdentity();
                      const contacts = await (await import('./contact-store.js')).listContacts();
                      return {fingerprint:identity.publicBundle.fingerprint, extractable:identity.privateKey.extractable,
                              names:contacts.map(contact => contact.name)};
                    }''')
                    assert preserved == {'fingerprint': identity, 'extractable': False, 'names': ['Prueba conservada']}
                    passed('The real private CryptoKey and saved public contact survive migration')

                    before = HostingGate.requests['/styles.css']
                    results = page.evaluate('''async () => {
                      const out=[];
                      for(let i=0;i<2;i++) out.push((await fetch('./styles.css')).status);
                      return out;
                    }''')
                    assert results == [200, 200]
                    assert HostingGate.requests['/styles.css'] == before + 2
                    passed('Repeated static fetches reach the server despite its cacheable asset headers')

                    await_install = "async () => (await import('./install.js?v=10')).initInstallUI().then(reg => reg.active?.scriptURL)"
                    assert page.evaluate(await_install).endswith('/sw.js?v=10')
                    for button in ('installShortcut', 'installApp'):
                        page.locator('#'+button).click()
                        assert 'pantalla de inicio' in page.locator('#installStatus').inner_text()
                        assert page.locator('details').get_attribute('open') is not None
                    assert 'Necesitas internet' in page.locator('#offlineStatus').inner_text()
                    passed('Both install buttons expose usable instructions and state the internet requirement')

                    for status, suffix in ((401, ''), (403, '?modo=recibir'), (503, '')):
                        HostingGate.mode = status
                        target = context.new_page()
                        response = target.goto(base+suffix, wait_until='domcontentloaded')
                        assert response.status == status
                        assert 'DENIED BY TEST GATE' in target.locator('body').inner_text()
                        assert target.locator('#sourceFile').count() == 0
                        fetch_status = page.evaluate("async () => (await fetch('./app.js?v=10')).status")
                        assert fetch_status == status
                        target.close()
                        passed(f'Hosting {status} passes through for navigation and JavaScript without cached application')

                    HostingGate.mode = 302
                    target = context.new_page()
                    assert target.goto(base, wait_until='domcontentloaded').status == 200
                    assert target.url.endswith('/__login__.html')
                    assert target.locator('h1').inner_text() == 'LOGIN STUB'
                    assert target.locator('#sourceFile').count() == 0
                    target.close()
                    passed('A hosting login redirect reaches the browser without returning cached app HTML')
                    assert sorted(page.evaluate('() => caches.keys()')) == sorted(caches_after)
                    passed('No private response, login page, denial or static resource creates a new app cache')
                    context.set_offline(True)
                    assert page.evaluate("async () => (await fetch('./app.js?v=10')).status") == 503
                    passed('An offline JavaScript fetch returns 503 instead of legacy cached code')
                finally:
                    context.close()

                context = pw.chromium.launch_persistent_context(profile, executable_path=EDGE, headless=True)
                try:
                    context.set_offline(True)
                    page = context.new_page()
                    response = page.goto(base, wait_until='domcontentloaded')
                    assert response.status == 503
                    assert 'Conéctate para abrir NEBO' in page.locator('h1').inner_text()
                    assert page.locator('#sourceFile').count() == 0
                    assert page.locator('script').count() == 0
                    assert page.evaluate('() => !!navigator.serviceWorker.controller && !navigator.onLine')
                    # The connection-only response also has default-src 'none',
                    # so it cannot load scripts or perform page-initiated fetches.
                    assert response.headers['content-security-policy'].startswith("default-src 'none'")
                    report['real_browser_restart'] = True
                    passed('Cold offline launch after a full browser restart shows only the connection notice')

                    saved = page.evaluate('''async () => new Promise((resolve,reject) => {
                      const request=indexedDB.open('astra-private-identities-v1',1);
                      request.onerror=()=>reject(request.error);
                      request.onsuccess=()=>{
                        const db=request.result, tx=db.transaction('identities','readonly');
                        const record=tx.objectStore('identities').get('current');
                        tx.oncomplete=()=>{db.close();resolve({fingerprint:record.result.publicBundle.fingerprint,
                                                             extractable:record.result.privateKey.extractable});};
                        tx.onabort=()=>{db.close();reject(tx.error);};
                      };
                    })''')
                    assert saved == {'fingerprint': identity, 'extractable': False}
                    assert sorted(page.evaluate('() => caches.keys()')) == sorted(caches_after)
                    passed('Private identity and unrelated caches persist after restart without storing the app')
                finally:
                    context.close()
        report['profile_deleted'] = not profile_path.exists()
        assert report['profile_deleted']
        report['status'] = 'PASS'
    except Exception as error:
        report['status'] = 'FAIL'
        report['error'] = str(error)
        raise
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        report['seconds'] = round(time.monotonic()-started, 3)
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')
        print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    run()
