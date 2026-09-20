"""One unavailable essential asset must prevent a partial offline installation."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'


class InterruptedAssets(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/__test__.html':
            data = b'<!doctype html><title>Atomic installation test</title>'
            self.send_response(200); self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        elif self.path == '/assets/coast.png':
            self.send_error(503, 'Deliberately unavailable essential asset')
        else:
            try:
                super().do_GET()
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                pass  # Cache.addAll cancels sibling downloads after the intentional 503.


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(InterruptedAssets, directory=str(ROOT/'public')))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=EDGE, headless=True)
            try:
                context = browser.new_context(); page = context.new_page()
                page.goto(f'http://127.0.0.1:{server.server_port}/__test__.html')
                outcome = page.evaluate("""async()=>{
                  for(const name of ['other-application-cache','nebo-app-v7']) {
                    const c=await caches.open(name);await c.put('./sentinel',new Response('keep'));
                  }
                  const reg=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
                  const worker=reg.installing;
                  const state=await new Promise((resolve,reject)=>{
                    const timer=setTimeout(()=>reject(Error('Failed install did not settle')),30000);
                    const check=()=>{if(worker.state==='redundant'||worker.state==='activated'){clearTimeout(timer);resolve(worker.state)}};
                    worker.addEventListener('statechange',check);check();
                  });
                  const cached=await caches.open('nebo-app-v8');
                  return {state,active:!!reg.active,current_entries:(await cached.keys()).length,cache_names:await caches.keys()};
                }""")
                assert outcome['state'] == 'redundant' and not outcome['active']
                assert outcome['current_entries'] == 0
                assert all(name in outcome['cache_names'] for name in ['other-application-cache','nebo-app-v7'])
            finally:
                browser.close()
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=5)
    report = {'status':'PASS','essential_asset_failure':503,'partial_cache_entries':0,
              'worker_not_activated':True,'previous_and_unrelated_caches_preserved':True}
    (ROOT/'tests/PWA_FAILURE_REPORT.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report),flush=True)


if __name__ == '__main__':
    run()
