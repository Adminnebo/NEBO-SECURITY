"""Browser audit of public contacts and a cold offline application launch.

Uses a temporary Edge profile under tests/, verifies that path before cleanup,
and closes/restarts the complete browser before the offline launch.
"""
import argparse
import json
from pathlib import Path
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

CONTACT_TEST = r"""async () => {
  const contacts = await import('./contact-store.js');
  const cryptoModule = await import('./secure-worker.js');
  const identityModule = await import('./identity-store.js');
  const assert = (condition, message) => {if (!condition) throw Error(message)};
  const rejects = async (operation) => {let rejected=false;try{await operation()}catch{rejected=true}assert(rejected,'Invalid input was accepted')};
  const checks=[];
  const passed=(name)=>checks.push({test:name,passed:true});
  const identity=await identityModule.createIdentity();
  const originalIdentity=identity.publicBundle.fingerprint;
  const one=(await cryptoModule.generateIdentity()).publicBundle;
  const saved=await contacts.saveContact('  Café de prueba  ',one);
  assert(saved.id===one.fingerprint && saved.name==='Café de prueba','Contact name or fingerprint mismatch');
  const renamed=await contacts.saveContact('Renombrado',one);
  assert(renamed.createdAt===saved.createdAt && (await contacts.listContacts()).length===1,'Upsert duplicated the contact');
  passed('Validated public recipient saves and upserts by fingerprint while preserving creation time');
  await rejects(()=>contacts.saveContact('',one));
  await rejects(()=>contacts.saveContact('x'.repeat(61),one));
  await rejects(()=>contacts.saveContact('line\nbreak',one));
  const unicode=await contacts.saveContact('🗻'.repeat(60),one);
  assert(Array.from(unicode.name).length===60,'Unicode alias length incorrect');
  await contacts.saveContact('Renombrado',one);
  passed('Alias bounds count Unicode code points and reject empty, oversized or control-containing names');
  await rejects(()=>contacts.saveContact('Invalid',{...one,fingerprint:'0'.repeat(64)}));
  await rejects(()=>contacts.saveContact('Private',{...one,privateKey:identity.privateKey}));
  await rejects(()=>contacts.saveContact('Private JWK',{...one,publicKey:{...one.publicKey,d:'secret'}}));
  await rejects(()=>contacts.removeContact('../bad'));
  passed('Forged fingerprints, private-key fields and invalid identifiers are rejected');
  const keys=await Promise.all(Array.from({length:50},()=>cryptoModule.generateIdentity()));
  const outcomes=await Promise.allSettled(keys.map((key,index)=>contacts.saveContact(`Contacto ${index}`,key.publicBundle)));
  assert(outcomes.filter(x=>x.status==='fulfilled').length===49,'Concurrent cap was not atomic');
  assert(outcomes.filter(x=>x.status==='rejected').length===1,'Expected exactly one limit rejection');
  assert((await contacts.listContacts()).length===50,'Stored contact count exceeds limit');
  await contacts.saveContact('Renombrado al límite',one);
  passed('Concurrent writes enforce the 50-contact cap and still allow existing-contact updates');
  const raw=await new Promise((resolve,reject)=>{const open=indexedDB.open('nebo-public-contacts-v1',1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction('contacts','readonly');const req=tx.objectStore('contacts').getAll();tx.oncomplete=()=>{db.close();resolve(req.result)};tx.onabort=()=>{db.close();reject(tx.error)}}});
  assert(raw.every(r=>Object.keys(r).sort().join('|')==='createdAt|id|name|publicBundle'),'Unexpected stored fields');
  assert(raw.every(r=>Object.keys(r.publicBundle.publicKey).sort().join('|')==='crv|kty|x|y'),'Non-public JWK stored');
  assert(!JSON.stringify(raw).includes('privateKey'),'Private key leaked to contacts');
  passed('IndexedDB contains only names, timestamps and validated public bundles');
  await contacts.removeContact(one.fingerprint);assert((await contacts.listContacts()).length===49,'Delete failed');
  await contacts.saveContact('Persistente',one);
  const after=await identityModule.loadIdentity();
  assert(after.publicBundle.fingerprint===originalIdentity && after.privateKey.extractable===false,'Private identity was modified');
  passed('Contact removal and replacement leave the private identity database unchanged');
  return {checks,contact_count:50,identity_fingerprint:originalIdentity,contact_fingerprint:one.fingerprint};
}"""


def run(args):
    checks = []
    report = {'status':'RUNNING','base_url':args.base_url,'checks':checks,'page_errors':[],
              'real_browser_restart':True,'private_test_profile_deleted':False}
    started = time.monotonic()
    def passed(name, **detail):
        checks.append({'test':name,'passed':True,**detail});print('PASS '+name,flush=True)
    with tempfile.TemporaryDirectory(prefix='nebo-pwa-audit-',dir=ROOT/'tests') as profile:
        profile_path=Path(profile).resolve()
        assert profile_path.parent==(ROOT/'tests').resolve() and profile_path.name.startswith('nebo-pwa-audit-')
        with sync_playwright() as pw:
            context=pw.chromium.launch_persistent_context(str(profile_path),executable_path=EDGE,headless=True,
                accept_downloads=True,viewport={'width':1200,'height':900})
            try:
                page=context.new_page();page.on('pageerror',lambda err:report['page_errors'].append(str(err)))
                assert page.goto(args.base_url,wait_until='networkidle').status==200
                page.locator('body[data-worker-ready="true"]').wait_for(timeout=45000)
                contacts=page.evaluate(CONTACT_TEST)
                checks.extend(contacts['checks'])
                for check in contacts['checks']:print('PASS '+check['test'],flush=True)
                registration=page.evaluate("""async()=>{
                  const r=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('SW install timed out')),60000))]);
                  return {scope:r.scope,active:r.active?.state};
                }""")
                assert registration['active']=='activated'
                inventory=page.evaluate("""async()=>{
                  const cache=await caches.open('nebo-app-v8');
                  return (await cache.keys()).map(r=>({url:r.url,method:r.method}));
                }""")
                assert len(inventory)>=20 and all(r['method']=='GET' for r in inventory)
                assert all(not any(value in r['url'] for value in ['secret=','token=','blob:','data:']) for r in inventory)
                awaitless=page.evaluate("""async()=>{
                  const c=await caches.open('unrelated-test-cache');await c.put('./unrelated-probe',new Response('preserve'));
                  return await caches.keys();
                }""")
                assert 'unrelated-test-cache' in awaitless
                passed('Essential static application assets are precached; cache contains no transfer inputs',cached_assets=len(inventory))
                try:
                    session=context.new_cdp_session(page)
                    report['browser_installability_errors']=session.send('Page.getInstallabilityErrors').get('installabilityErrors',[])
                    session.detach()
                except Exception as exc:
                    report['browser_installability_probe']='Unavailable: '+type(exc).__name__
                report['cached_urls']=[item['url'] for item in inventory]
                portable=page.evaluate("""async()=>{
                  const codec=await import('./secure-worker.js');const identities=await import('./identity-store.js');
                  const identity=await identities.loadIdentity();const file=new TextEncoder().encode('NEBO cold offline recovery: café.');
                  const cover={width:64,height:64,channels:3,data:new Uint8Array(64*64*3).fill(174).buffer};
                  const secret=await codec.encodeSecure({file:file.buffer,name:'offline.txt',mime:'text/plain',cover,embed_token:true});
                  const recipient=await codec.encodeSecure({file:file.buffer,name:'offline.txt',mime:'text/plain',cover,embed_token:true,recipient:identity.publicBundle});
                  return {secret_art:Array.from(new Uint8Array(secret.artwork)),secret:secret.recovery_secret,recipient_art:Array.from(new Uint8Array(recipient.artwork))};
                }""")
            finally:context.close()

            # A fully new browser process, the same profile, and offline before navigation.
            context=pw.chromium.launch_persistent_context(str(profile_path),executable_path=EDGE,headless=True,
                accept_downloads=True,viewport={'width':1200,'height':900})
            try:
                context.set_offline(True)
                page=context.new_page();page.on('pageerror',lambda err:report['page_errors'].append(str(err)))
                assert page.goto(args.base_url,wait_until='domcontentloaded',timeout=15000).status==200
                page.locator('body[data-worker-ready="true"]').wait_for(timeout=30000)
                persisted=page.evaluate("""async()=>{
                  const c=await import('./contact-store.js');const i=await import('./identity-store.js');
                  const rows=await c.listContacts(),identity=await i.loadIdentity();
                  return {count:rows.length,ids:rows.map(r=>r.id),identity:identity.publicBundle.fingerprint,extractable:identity.privateKey.extractable,
                    controller:!!navigator.serviceWorker.controller,online:navigator.onLine,caches:await caches.keys()};
                }""")
                assert persisted['controller'] and not persisted['online']
                assert persisted['count']==50 and contacts['contact_fingerprint'] in persisted['ids']
                assert persisted['identity']==contacts['identity_fingerprint'] and not persisted['extractable']
                assert 'unrelated-test-cache' in persisted['caches']
                passed('Full browser restart opens app and both codecs offline from cached assets')
                passed('Public contacts and unchanged nonextractable private identity survive a cold offline restart')
                recovered=page.evaluate("""async(input)=>{
                  const codec=await import('./secure-worker.js');const identities=await import('./identity-store.js');
                  const identity=await identities.loadIdentity();
                  const secret=await codec.decodeSecure({artwork:new Uint8Array(input.secret_art).buffer,secret:input.secret});
                  const recipient=await codec.decodeSecure({artwork:new Uint8Array(input.recipient_art).buffer,privateKey:identity.privateKey,recipientPublic:identity.publicBundle});
                  return {secret:new TextDecoder().decode(secret.file),recipient:new TextDecoder().decode(recipient.file)};
                }""",portable)
                assert recovered['secret']==recovered['recipient']=='NEBO cold offline recovery: café.'
                passed('Single portable PNG recovers exact secret-mode and recipient-mode content after cold offline launch')
                legacy=ROOT/'tests/fixtures/png_alpha'
                page.locator('#receiverTab').click()
                page.locator('#receivedArt').set_input_files({'name':'artwork.png','mimeType':'image/png','buffer':(legacy/'artwork.png').read_bytes()})
                page.locator('#receivedToken').set_input_files({'name':'token.json','mimeType':'application/json','buffer':(legacy/'token.json').read_bytes()})
                page.locator('#decodeButton').click()
                page.locator('#receiverResult:not(.hidden)').wait_for(timeout=60000)
                with page.expect_download() as download:
                    page.locator('#downloadRestored').click()
                assert Path(download.value.path()).read_bytes()==(legacy/'original.bin').read_bytes()
                passed('Classic PNG plus token recovers exact original after cold offline browser launch')
                after_urls=page.evaluate("""async()=> (await (await caches.open('nebo-app-v8')).keys()).map(r=>r.url).sort()""")
                assert after_urls==sorted(report['cached_urls'])
                passed('Recovery operations add no artwork, tokens, secrets or files to the application cache')
                assert not report['page_errors'],report['page_errors']
            finally:context.close()
    report['private_test_profile_deleted']=True
    report['status']='PASS';report['seconds']=round(time.monotonic()-started,3)
    Path(args.report).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'status':report['status'],'checks':len(checks),'seconds':report['seconds']}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='http://127.0.0.1:8774')
    parser.add_argument('--report',default=str(ROOT/'tests/PWA_CONTACTS_REPORT.json'))
    run(parser.parse_args())
