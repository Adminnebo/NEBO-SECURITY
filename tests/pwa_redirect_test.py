"""Hosting regression: redirected precached index must still navigate offline."""
import functools
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'


class CanonicalHosting(SimpleHTTPRequestHandler):
    def log_message(self,*args):
        pass

    def do_GET(self):
        if self.path=='/index.html':
            self.send_response(301);self.send_header('Location','/')
            self.send_header('Content-Length','0');self.end_headers();return
        try:
            super().do_GET()
        except (ConnectionAbortedError,ConnectionResetError,BrokenPipeError):
            pass


def run():
    started=time.monotonic()
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(CanonicalHosting,directory=str(ROOT/'public')))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    base=f'http://127.0.0.1:{server.server_port}/'
    try:
        with tempfile.TemporaryDirectory(prefix='nebo-redirect-audit-',dir=ROOT/'tests') as profile:
            assert Path(profile).resolve().parent==(ROOT/'tests').resolve()
            with sync_playwright() as pw:
                context=pw.chromium.launch_persistent_context(profile,executable_path=EDGE,headless=True)
                try:
                    page=context.new_page();page.goto(base,wait_until='networkidle')
                    page.locator('body[data-worker-ready="true"]').wait_for(timeout=30000)
                    stored=page.evaluate("""async()=>{
                      const reg=await navigator.serviceWorker.ready;
                      if(reg.active.state!=='activated')await new Promise(ok=>reg.active.addEventListener('statechange',()=>reg.active.state==='activated'&&ok()));
                      const response=await(await caches.open('nebo-app-v9')).match(new URL('./index.html',location.href));
                      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',await response.clone().arrayBuffer()));
                      return {redirected:response.redirected,status:response.status,url:response.url,sha256:Array.from(hash,x=>x.toString(16).padStart(2,'0')).join('')};
                    }""")
                    assert stored['redirected'] and stored['status']==200 and stored['url']==base
                finally:
                    context.close()
                context=pw.chromium.launch_persistent_context(profile,executable_path=EDGE,headless=True)
                try:
                    context.set_offline(True);page=context.new_page()
                    response=page.goto(base,wait_until='domcontentloaded',timeout=15000)
                    assert response.status==200
                    assert hashlib.sha256(response.body()).hexdigest()==stored['sha256']
                    page.locator('body[data-worker-ready="true"]').wait_for(timeout=30000)
                    assert page.evaluate('()=>!!navigator.serviceWorker.controller&&!navigator.onLine')
                    assert page.locator('#sourceFile').count()==1
                finally:
                    context.close()
    finally:
        server.shutdown();server.server_close();thread.join(timeout=5)
    report={'status':'PASS','application_cache':'nebo-app-v9','canonical_redirect':'/index.html -> /',
            'cached_response_redirected':True,'real_browser_restart':True,'offline_before_navigation':True,
            'offline_navigation_status':200,'offline_html_bytes_identical':True,'both_codecs_ready':True,
            'seconds':round(time.monotonic()-started,3)}
    (ROOT/'tests/PWA_REDIRECT_REPORT.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report),flush=True)


if __name__=='__main__':
    run()
