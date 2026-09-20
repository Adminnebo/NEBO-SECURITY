"""Browser checks for the simplified composer, immediate preview and portable PNG."""
import argparse
import hashlib
import json
import os
from urllib.parse import urlsplit
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from multi_message_test import wait_ready, wait_result, download, upload, EDGE

ROOT = Path(__file__).resolve().parents[1]

def run(base, report):
    # Optional owner-only hosting test credential; never written to reports or disk.
    owner_token = os.environ.pop('NEBO_SITES_AUDIT_TOKEN', '')
    native_user = os.environ.pop('NEBO_TEST_LOGIN_USER', '')
    native_password = os.environ.pop('NEBO_TEST_LOGIN_PASSWORD', '')
    headers = {'OAI-Sites-Authorization': 'Bearer ' + owner_token} if owner_token else {}
    report['access_check'] = 'owner_testing_header' if owner_token else 'normal_browser'
    if native_user and native_password:
        report['access_check'] = 'nebo_username_password'
    def sign_in(ctx):
        if not native_user or not native_password: return
        parsed = urlsplit(base)
        origin = parsed.scheme + '://' + parsed.netloc
        response = ctx.request.post(base + '/api/auth/login',
                                    headers={'Origin':origin},
                                    data={'username':native_user,'password':native_password})
        assert response.status == 200, 'NEBO test-account login did not succeed'
    def protect_test_credential(ctx):
        if not owner_token: return
        allowed_origin = urlsplit(base).netloc
        def route_request(route):
            target = urlsplit(route.request.url)
            if target.scheme in ('http', 'https') and target.netloc != allowed_origin:
                route.abort()
            elif target.path == '/sw.js':
                # Chromium omits context extra headers from the initial SW
                # script fetch. Supply the same QA header to that request only.
                route.continue_(headers={**route.request.headers, **headers})
            else: route.continue_()
        ctx.route('**/*', route_request)
    def passed(name, **details):
        report['checks'].append({'test': name, 'passed': True, **details})
        print('PASS ' + name, flush=True)
    with sync_playwright() as pw:
        local = urlsplit(base).hostname in ('localhost','127.0.0.1')
        browser = pw.chromium.launch(executable_path=EDGE, headless=True,
                                     args=['--ignore-certificate-errors'] if local else [])
        context = browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True, service_workers='allow', extra_http_headers=headers, ignore_https_errors=True)
        protect_test_credential(context)
        sign_in(context)
        context.add_init_script("""(() => {
          Object.defineProperty(navigator, 'canShare', {value: () => true});
          Object.defineProperty(navigator, 'share', {value: async ({files}) => {window.__shared = files.map(f=>({name:f.name,type:f.type,size:f.size}));}});
        })()""")
        page = context.new_page()
        page.on('pageerror', lambda e: report['page_errors'].append(str(e)))
        page.goto(base, wait_until='networkidle'); wait_ready(page)
        expect(page.locator('#liveCoverImage')).to_be_visible()
        assert page.locator('#liveCoverImage').evaluate('(img) => img.complete && img.naturalWidth > 0')
        assert page.locator('#liveCoverImage').bounding_box()['y'] < 844
        expect(page.locator('#textEditor')).to_be_visible()
        passed('Mobile cover and composer visible on first load without clicking')
        page.locator('#editCoverButton').click()
        page.locator('[data-cover="coast"]').click()
        expect(page.locator('#liveCoverImage')).to_have_attribute('src', __import__('re').compile('coast.png$'))
        page.locator('#coverStyle').select_option('vivid')
        assert 'saturate' in page.locator('#liveCoverImage').evaluate('(el)=>el.style.filter')
        page.locator('#mobileBack').click()
        text = 'Un solo clic: café, montaña, voz y archivos.\nMensaje de prueba exacto.'
        page.locator('#textInput').fill(text)
        expect(page.locator('#mobileAction')).to_be_enabled()
        page.locator('#mobileAction').click(); wait_result(page, 'sender')
        art, _ = download(page, '#downloadArt')
        secret = page.locator('#recoverySecret').input_value()
        assert len(secret) == 43
        assert b'neBo' in art
        assert secret.encode() not in art
        assert page.locator('#textInput').input_value() == ''
        expect(page.locator('#senderStats')).to_contain_text('Token integrado')
        page.locator('#sharePackage').click()
        files = page.evaluate('() => window.__shared')
        assert len(files) == 1 and files[0]['type'] == 'image/png'
        passed('Draft included by one Create click; share includes only portable PNG, secret separate', png_bytes=len(art), shared_files=len(files))
        fresh = browser.new_context(viewport={'width':390, 'height':844}, accept_downloads=True, service_workers='allow', extra_http_headers=headers, ignore_https_errors=True)
        protect_test_credential(fresh)
        sign_in(fresh)
        receiver = fresh.new_page()
        receiver.on('pageerror', lambda e: report['page_errors'].append(str(e)))
        receiver.goto(base + '/?modo=recibir', wait_until='networkidle'); wait_ready(receiver)
        receiver.locator('#receivedArt').set_input_files(upload('mensaje.png', 'image/png', art))
        expect(receiver.locator('#receivedPreview')).to_be_visible()
        expect(receiver.locator('#embeddedTokenStatus')).to_contain_text('Token integrado detectado')
        assert not receiver.locator('#legacyTokenOptions').evaluate('(el)=>el.open')
        receiver.locator('#receivedSecret').fill('B' * 43)
        receiver.locator('#mobileAction').click()
        expect(receiver.locator('#receiverError')).to_be_visible(timeout=45000)
        expect(receiver.locator('#receiverResult')).to_be_hidden()
        receiver.locator('#receivedSecret').fill(secret)
        receiver.locator('#mobileAction').click()
        # The private release awaits the network access probe before clearing
        # the previous error; do not mistake that old error for the new result.
        expect(receiver.locator('#receiverError')).to_be_hidden(timeout=15000)
        wait_result(receiver, 'receiver')
        data, name = download(receiver, '#downloadRestored')
        assert data == text.encode('utf8')
        expect(receiver.locator('#restoredPreview pre')).to_have_text(text)
        passed('Fresh receiver opens PNG + key only; preview immediate; wrong key rejected; bytes exact', source_sha256=hashlib.sha256(data).hexdigest())
        fresh.close()
        page.locator('#mobileAction').click()
        expect(page.locator('#textEditor')).to_be_visible()
        page.locator('#editCoverButton').click()
        page.locator('#advancedAccess').evaluate('(el)=>el.open=true')
        page.locator('input[name=accessMode][value=recipient]').check()
        bundle = page.evaluate("""async () => {
          const m=await import('./identity-store.js'); const id=await m.createIdentity();
          return JSON.parse(await m.exportPublicIdentity(id));
        }""")
        page.locator('#recipientFile').set_input_files(upload('public.json', 'application/json', json.dumps(bundle).encode()))
        expect(page.locator('#recipientSummary')).to_be_visible()
        expect(page.locator('#saveContact')).to_be_disabled()
        page.locator('#recipientVerified').check()
        page.locator('#contactName').fill('Contacto de prueba')
        page.locator('#saveContact').click()
        expect(page.locator('#contactStatus')).to_contain_text('guardado')
        assert page.locator('#savedContact').input_value()
        page.reload(wait_until='networkidle'); wait_ready(page)
        page.locator('#editCoverButton').click()
        page.locator('#advancedAccess').evaluate('(el)=>el.open=true')
        page.locator('input[name=accessMode][value=recipient]').check()
        expect(page.locator('#savedContact option')).to_have_count(2)
        page.locator('#savedContact').select_option(label='Contacto de prueba')
        expect(page.locator('#recipientVerified')).to_be_checked()
        expect(page.locator('#recipientSummary')).to_be_visible()
        page.locator('#removeContact').click()
        expect(page.locator('#savedContact option')).to_have_count(1)
        assert page.evaluate("async () => Boolean(await (await import('./identity-store.js')).loadIdentity())")
        passed('Trusted contact UI validates confirmation, persists alias, selects saved public identity, removes without deleting private key')
        assert not report['page_errors'], report['page_errors']
        browser.close()

if __name__ == '__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--base-url', default='http://127.0.0.1:8774'); ap.add_argument('--report', default=str(ROOT/'tests/V8_USERFLOW_REPORT.json')); args=ap.parse_args()
    result={'base_url':args.base_url,'checks':[],'page_errors':[]}
    try:
        run(args.base_url.rstrip('/'), result); result['passed']=True
    except Exception as error:
        result['passed']=False; result['error']=str(error); raise
    finally:
        Path(args.report).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
