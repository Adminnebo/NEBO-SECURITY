"""Real UI audit for private and identity-directed ASTRA transfers.

The receiving contexts get only downloaded artwork, token, and either the
separate recovery secret or their own persisted recipient identity.
"""
import argparse
import io
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

from secure_audit_core import ROOT, FIXTURES, OUT, canonical, sha, oracle, BOOT, call, b64, unb64, u64


def wait_ready(page):
    page.locator('body[data-worker-ready="true"]').wait_for(timeout=45000)


def download(page, selector):
    with page.expect_download(timeout=60000) as info:
        page.locator(selector).click()
    item=info.value
    return Path(item.path()).read_bytes(),item.suggested_filename


def wait_sender(page, old_href=None):
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        if page.locator('#senderError:not(.hidden)').count():
            raise AssertionError(page.locator('#senderError').inner_text())
        if page.locator('#senderResult:not(.hidden)').count():
            href=page.locator('#downloadArt').get_attribute('href')
            if href and href!=old_href:return
        time.sleep(.1)
    raise AssertionError('Sender UI never delivered a new artifact')


def receiver_files(page,art,token):
    page.locator('#receivedArt').set_input_files({'name':'artwork.png','mimeType':'image/png','buffer':art})
    page.locator('#receivedToken').set_input_files({'name':'token.json','mimeType':'application/json','buffer':token})


def restore_ui(page,source,filename):
    page.locator('#decodeButton').click()
    page.locator('#receiverResult:not(.hidden) #receiverHash').filter(has_text=sha(source)).wait_for(state='attached',timeout=180000)
    actual,name=download(page,'#downloadRestored')
    assert actual==source and name==filename


def run(args):
    OUT.mkdir(exist_ok=True)
    manifest=json.loads((FIXTURES/'manifest.json').read_text('utf-8'))
    fixture=manifest[0];source=(FIXTURES/fixture['kind']/'original.bin').read_bytes()
    checks=[];errors=[];blocked=[]
    def passed(label,**detail):
        checks.append({'test':label,'passed':True,**detail});print('PASS '+label,flush=True)
    started=time.monotonic()
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless=True)
        contexts=[browser.new_context(accept_downloads=True,viewport={'width':1440,'height':1100}) for _ in range(3)]
        sender,receiver,identity_page=[context.new_page() for context in contexts]
        for page in (sender,receiver,identity_page):
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
            response=page.goto(args.base_url,wait_until='networkidle');assert response.status==200
            wait_ready(page)
        assert sender.locator('#encodingMode').input_value()=='private'
        sender.locator('#sourceFile').set_input_files({'name':fixture['filename'],'mimeType':fixture['mime'],'buffer':source})
        sender.locator('#encodeButton').click();wait_sender(sender)
        art,_=download(sender,'#downloadArt');token,_=download(sender,'#downloadToken')
        secret=sender.locator('#recoverySecret').input_value()
        assert len(secret)==43 and secret not in sender.url
        restored,metadata,body,_=oracle(art,token,secret=secret)
        assert restored==source and metadata['name']==fixture['filename']
        assert json.loads(token)['format']=='ASTRA-SECURE-V2'
        passed('Default private UI generates independently authenticated PNG/token and separate secret',png_bytes=len(art),token_bytes=len(token))
        contexts[1].route('**/*',lambda route:(blocked.append(route.request.url),route.abort())[1])
        contexts[1].set_offline(True)
        receiver.locator('#receiverTab').click();receiver_files(receiver,art,token)
        receiver.locator('#receivedSecret').fill('A'*43)
        receiver.locator('#decodeButton').click()
        receiver.locator('#receiverError:not(.hidden)').wait_for(timeout=60000)
        assert receiver.locator('#receiverResult').evaluate("e=>e.classList.contains('hidden')")
        receiver.locator('#receivedSecret').fill(secret)
        restore_ui(receiver,source,fixture['filename'])
        passed('Fresh offline recipient UI rejects wrong key then downloads exact original with correct key')
        # Solid cover allows independent comparison with actual output pixels.
        cover=Image.new('RGB',(48,32),(22,104,208));buf=io.BytesIO();cover.save(buf,'PNG')
        sender.locator('#coverFile').set_input_files({'name':'blue-cover.png','mimeType':'image/png','buffer':buf.getvalue()})
        sender.locator('#coverResolution').select_option('3840')
        sender.locator('#coverStyle').select_option('original')
        previous=sender.locator('#downloadArt').get_attribute('href')
        sender.locator('#encodeButton').click();wait_sender(sender,previous)
        hd_art,_=download(sender,'#downloadArt');hd_token,_=download(sender,'#downloadToken')
        hd_secret=sender.locator('#recoverySecret').input_value()
        restored,_,hd_body,pixels=oracle(hd_art,hd_token,secret=hd_secret)
        assert restored==source and (hd_body['width'],hd_body['height'])==(3840,2560)
        assert np.all((pixels>>hd_body['bits'])==(np.array([22,104,208],dtype=np.uint8)>>hd_body['bits']))
        assert hd_art!=art
        passed('Custom cover and 4K UI produce actual 3840 x 2560 cover-preserving PNG',width=3840,height=2560,png_bytes=len(hd_art),bits=hd_body['bits'])
        # Create an actual UI identity, export only its public bundle, then reload.
        identity_page.locator('#identitySection > summary').click()
        identity_page.locator('#createIdentity').click()
        identity_page.locator('#exportIdentity:not(.hidden)').wait_for(timeout=60000)
        public_bytes,_=download(identity_page,'#exportIdentity')
        public=json.loads(public_bytes)
        assert set(public)=={'format','publicKey','fingerprint'} and set(public['publicKey'])=={'kty','crv','x','y'}
        assert sha(canonical(public['publicKey']))==public['fingerprint']
        identity_page.reload(wait_until='networkidle');wait_ready(identity_page)
        identity_page.locator('#identityFingerprint:not(.hidden)').filter(has_text=public['fingerprint']).wait_for(state='attached',timeout=30000)
        assert ''.join(identity_page.locator('#identityFingerprint').text_content().split())==public['fingerprint']
        passed('UI creates public-only recipient identity with independently verified fingerprint and persistent reload')
        sender.locator('#coverResolution').select_option('2048')
        sender.locator('input[name=accessMode][value=recipient]').check()
        sender.locator('#recipientFile').set_input_files({'name':'recipient.json','mimeType':'application/json','buffer':public_bytes})
        sender.locator('#recipientSummary:not(.hidden)').wait_for()
        assert sender.locator('#encodeButton').is_disabled()
        displayed=sender.locator('#recipientFingerprint').inner_text().replace(' ','').replace('\n','')
        assert displayed==public['fingerprint']
        sender.locator('#recipientVerified').check()
        previous=sender.locator('#downloadArt').get_attribute('href')
        sender.locator('#encodeButton').click();wait_sender(sender,previous)
        recipient_art,_=download(sender,'#downloadArt');recipient_token,_=download(sender,'#downloadToken')
        assert json.loads(recipient_token)['mode']=='recipient'
        assert sender.locator('#secretResult').evaluate("e=>e.classList.contains('hidden')")
        passed('Recipient UI requires explicit fingerprint confirmation and generates no shared secret')
        contexts[2].route('**/*',lambda route:(blocked.append(route.request.url),route.abort())[1]);contexts[2].set_offline(True)
        identity_page.locator('#receiverTab').click();receiver_files(identity_page,recipient_art,recipient_token)
        restore_ui(identity_page,source,fixture['filename'])
        passed('Offline recipient UI uses persisted private identity to download exact original')
        receiver_files(receiver,recipient_art,recipient_token)
        receiver.locator('#receiverAccess:not(.hidden)').wait_for()
        if not receiver.locator('#decodeButton').is_disabled():
            receiver.locator('#decodeButton').click();receiver.locator('#receiverError:not(.hidden)').wait_for(timeout=60000)
        assert receiver.locator('#receiverResult').evaluate("e=>e.classList.contains('hidden')")
        passed('Receiver without the target identity cannot open recipient package')
        # Original public legacy package still opens without a secret.
        legacy=FIXTURES/fixture['kind'];receiver_files(receiver,(legacy/'artwork.png').read_bytes(),(legacy/'token.json').read_bytes())
        restore_ui(receiver,source,fixture['filename'])
        passed('Legacy ASTRA-MSG-V1 receiving interface remains compatible')
        # Actual text composer, independent of file upload fixtures.
        sender.locator('input[name=accessMode][value=secret]').check()
        sender.locator('#textButton').click();text='Private composer: café, montaña, 🏔️\nExact UTF-8.'
        sender.locator('#textInput').fill(text);sender.locator('#useText').click()
        previous=sender.locator('#downloadArt').get_attribute('href')
        sender.locator('#encodeButton').click();wait_sender(sender,previous)
        text_art,_=download(sender,'#downloadArt');text_token,_=download(sender,'#downloadToken')
        text_secret=sender.locator('#recoverySecret').input_value()
        recovered,meta,_,_=oracle(text_art,text_token,secret=text_secret)
        assert recovered==text.encode('utf-8')
        passed('Real text composer preserves exact UTF-8 through secure encoding')
        # Authenticated transport does not make decrypted active content safe.
        sender.evaluate(BOOT)
        hostile=b'<html><script>window.top.__auditActiveContent=true</script><h1>UNTRUSTED_AUDIT_HTML</h1></html>'
        packaged=call(sender,'encode',file=b64(hostile),name='untrusted.pdf',mime='text/html',
                      coverSpec={'width':64,'height':64,'seed':7})
        assert packaged['type']=='result'
        receiver_files(receiver,unb64(packaged['artwork']),unb64(packaged['token']))
        receiver.locator('#receivedSecret').fill(packaged['recovery_secret'])
        restore_ui(receiver,hostile,'untrusted.pdf')
        assert receiver.locator('#restoredPreview iframe,#restoredPreview object,#restoredPreview embed,#restoredPreview script').count()==0
        assert not receiver.evaluate('window.__auditActiveContent === true')
        passed('Authenticated HTML named .pdf is not embedded or executed; exact download remains available')
        pdf=(FIXTURES/'pdf_two_pages'/'original.bin').read_bytes()
        pdf_case=manifest[1]
        receiver_files(receiver,(OUT/'pdf_two_pages.png').read_bytes(),(OUT/'pdf_two_pages.json').read_bytes())
        receiver.locator('#receivedSecret').fill(u64(bytes(range(32))))
        restore_ui(receiver,pdf,pdf_case['filename'])
        assert receiver.locator('#restoredPreview iframe,#restoredPreview object,#restoredPreview embed').count()==0
        passed('Ordinary PDF uses safe download card and downloads all original bytes under CSP')
        identity_page.screenshot(path=str(OUT/'recipient_ui.png'),full_page=True)
        browser.close()
    report={'status':'PASS','base_url':args.base_url,'seconds':round(time.monotonic()-started,3),'checks':checks,
            'browser':'Microsoft Edge','anonymous_fresh_contexts':True,'recipient_network_disabled_after_load':True,
            'post_cutoff_network_attempts':blocked,'console_errors':errors,'secrets_in_report':False}
    (ROOT/'SECURITY_TEST_REPORT_UI.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'status':'PASS','checks':len(checks),'seconds':report['seconds'],'console_errors':errors}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--base-url',default='http://127.0.0.1:8770')
    run(parser.parse_args())
