"""Regression: choosing saved B must defeat an older, delayed identity A import."""
import argparse
import json
from pathlib import Path
import time
import traceback

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
DELAY = """(() => {
  const originalText = Blob.prototype.text;
  File.prototype.text = function(...args) {
    if (this.name !== 'slow-A.json') return originalText.apply(this, args);
    const file = this;
    document.body.dataset.auditReadPending = 'true';
    return new Promise((resolve, reject) => {
      window.__releaseRecipientRead = async () => {
        try { resolve(await originalText.call(file)); }
        catch(error) { reject(error); }
        finally { document.body.dataset.auditReadPending = 'false'; }
      };
    });
  };
})()"""


def run(args, report):
    def passed(name, **detail):
        report['checks'].append({'test':name,'passed':True,**detail})
        print('PASS '+name,flush=True)
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=EDGE,headless=True)
        try:
            context=browser.new_context(accept_downloads=True,viewport={'width':1440,'height':1050})
            helper=context.new_page()
            helper_url=args.base_url.rstrip('/')+'/__recipient-race-test__.html'
            helper.route(helper_url,lambda route:route.fulfill(status=200,content_type='text/html',body='<!doctype html><title>Synthetic test identities</title>'))
            helper.goto(helper_url)
            identities=helper.evaluate("""async()=>{
              const codec=await import('./secure-worker.js');const contacts=await import('./contact-store.js');
              window.__auditIdentities={A:await codec.generateIdentity(),B:await codec.generateIdentity()};
              await contacts.saveContact('B sintético confirmado',window.__auditIdentities.B.publicBundle);
              return {A:window.__auditIdentities.A.publicBundle,B:window.__auditIdentities.B.publicBundle};
            }""")
            page=context.new_page();page.add_init_script(DELAY)
            page.on('pageerror',lambda error:report['page_errors'].append(str(error)))
            assert page.goto(args.base_url,wait_until='networkidle').status==200
            page.locator('body[data-worker-ready="true"]').wait_for(timeout=45000)
            original='Solo B debe poder recuperar este mensaje exacto: café.'
            page.locator('#textInput').fill(original)
            page.locator('input[name=accessMode][value=recipient]').check()
            expect(page.locator('#savedContact option').filter(has_text='B sintético confirmado')).to_have_count(1)
            page.locator('#recipientFile').set_input_files({'name':'slow-A.json','mimeType':'application/json',
                'buffer':json.dumps(identities['A']).encode('utf-8')})
            page.locator('body[data-audit-read-pending="true"]').wait_for()
            expect(page.locator('#encodeButton')).to_be_disabled()
            expect(page.locator('#recipientVerified')).to_be_disabled()
            expect(page.locator('#savedContact')).to_be_enabled()
            passed('Delayed identity import blocks encoding and confirmation while allowing another saved contact')

            page.locator('#savedContact').select_option(identities['B']['fingerprint'])
            expect(page.locator('#recipientVerified')).to_be_checked()
            expect(page.locator('#recipientVerified')).to_be_enabled()
            expect(page.locator('#encodeButton')).to_be_enabled()
            expect(page.locator('#recipientFingerprint')).to_have_text(identities['B']['fingerprint'])
            passed('Selecting saved B supersedes the pending A import and confirms only B')

            page.evaluate('async()=>await window.__releaseRecipientRead()')
            # Release the genuine File.text read and allow its asynchronous validation
            # to finish before inspecting state and producing a cryptographic payload.
            page.wait_for_timeout(750)
            expect(page.locator('#savedContact')).to_have_value(identities['B']['fingerprint'])
            expect(page.locator('#recipientFingerprint')).to_have_text(identities['B']['fingerprint'])
            expect(page.locator('#recipientVerified')).to_be_checked()
            expect(page.locator('#contactName')).to_have_value('B sintético confirmado')
            assert page.locator('#senderError').evaluate("e=>e.classList.contains('hidden')")
            passed('Late completion of A cannot overwrite B or its verified state')

            page.locator('#encodeButton').click()
            page.locator('#senderResult:not(.hidden),#senderError:not(.hidden)').wait_for(timeout=120000)
            assert page.locator('#senderError').evaluate("e=>e.classList.contains('hidden')"),page.locator('#senderError').inner_text()
            with page.expect_download() as download:
                page.locator('#downloadArt').click()
            artwork=Path(download.value.path()).read_bytes()
            recovered=helper.evaluate("""async(input)=>{
              const codec=await import('./secure-worker.js');
              const portable=await import('./portable-png.js');
              const artwork=new Uint8Array(input.artwork).buffer;
              const header=JSON.parse(new TextDecoder().decode(portable.extractEmbeddedToken(artwork)));
              const B=window.__auditIdentities.B,A=window.__auditIdentities.A;
              const result=await codec.decodeSecure({artwork,privateKey:B.privateKey,recipientPublic:B.publicBundle});
              let wrongRejected=false;try{await codec.decodeSecure({artwork,privateKey:A.privateKey,recipientPublic:A.publicBundle})}catch{wrongRejected=true}
              return {mode:header.mode,intended:header.recipient_fingerprint===B.publicBundle.fingerprint,
                text:new TextDecoder().decode(result.file),wrongRejected};
            }""",{'artwork':list(artwork)})
            assert recovered=={'mode':'recipient','intended':True,'text':original,'wrongRejected':True}
            assert page.locator('#secretResult').evaluate("e=>e.classList.contains('hidden')")
            passed('Generated portable PNG is bound to B, decrypts exact bytes for B and rejects A',artwork_bytes=len(artwork))
            assert not report['page_errors'],report['page_errors']
        finally:
            browser.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='http://127.0.0.1:8774')
    parser.add_argument('--report',type=Path,default=ROOT/'tests/RECIPIENT_RACE_REPORT.json')
    args=parser.parse_args();started=time.monotonic()
    report={'status':'RUNNING','base_url':args.base_url,'checks':[],'page_errors':[],
            'synthetic_identities':True,'private_keys_exported':False,'controlled_File_text_delay':True}
    try:
        run(args,report);report['status']='PASS'
    except Exception as error:
        report['status']='FAIL';report['error']=str(error);report['traceback']=traceback.format_exc();raise
    finally:
        report['seconds']=round(time.monotonic()-started,3)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({'status':report['status'],'checks':len(report['checks']),'seconds':report['seconds']}),flush=True)
