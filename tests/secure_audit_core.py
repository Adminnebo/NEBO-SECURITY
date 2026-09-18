"""Independent ASTRA-SECURE-V2 browser/cryptography audit.

The Python oracle imports no production cryptography or payload codec.
Requires cryptography, NumPy, Pillow and Playwright. Existing fixtures from
tests/audit_web.py are reused. Run with --base-url http://127.0.0.1:8770.
"""
import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import struct
import time

import numpy as np
from PIL import Image
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
OUT = ROOT / "tests" / "secure_audit_artifacts"


def sha(data): return hashlib.sha256(data).hexdigest()
def b64(data): return base64.b64encode(data).decode("ascii")
def unb64(data): return base64.b64decode(data)
def u64(data): return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")
def unu64(data): return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
def canonical(value): return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")


def derive(secret, salt, label):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                info=("ASTRA-SECURE-V2/" + label).encode("ascii")).derive(secret)


def oracle(artwork, token_bytes, secret=None, private_key=None):
    """Independently authenticate, extract RGB LSB bits, decrypt and verify."""
    token = json.loads(token_bytes)
    header = {k: v for k, v in token.items() if k != "encrypted_body"}
    aad = canonical(header)
    if header["mode"] == "recipient":
        jwk = header["ephemeral_public"]
        point = ec.EllipticCurvePublicNumbers(int.from_bytes(unu64(jwk["x"]), "big"),
                                             int.from_bytes(unu64(jwk["y"]), "big"), ec.SECP256R1()).public_key()
        secret_bytes = private_key.exchange(ec.ECDH(), point)
    else:
        secret_bytes = unu64(secret)
    salt = unu64(header["salt"])
    token_key = derive(secret_bytes, salt, "token")
    payload_key = derive(secret_bytes, salt, "payload")
    assert token_key != payload_key
    body = json.loads(AESGCM(token_key).decrypt(unu64(header["token_iv"]), unu64(token["encrypted_body"]), aad))
    assert sha(artwork) == body["artwork_sha256"]
    with Image.open(io.BytesIO(artwork)) as image:
        assert image.mode == "RGB"
        assert image.size == (body["width"], body["height"])
        pixels = np.array(image, dtype=np.uint8)
    count = body["ciphertext_bytes"]
    bits = body["bits"]
    assert 1 <= bits <= 4
    channels = pixels.ravel()
    # Stream order is row-major RGB, most-significant payload bit first;
    # each channel contributes its low bits in descending bit significance.
    used = math.ceil(count * 8 / bits)
    low = channels[:used] & ((1 << bits) - 1)
    stream = ((low[:, None] >> np.arange(bits - 1, -1, -1)) & 1).astype(np.uint8).ravel()[:count * 8]
    ciphertext = np.packbits(stream).tobytes()
    plaintext = AESGCM(payload_key).decrypt(unu64(header["payload_iv"]), ciphertext, aad)
    metadata_bytes = int.from_bytes(plaintext[:4], "big")
    metadata = json.loads(plaintext[4:4 + metadata_bytes])
    original = plaintext[4 + metadata_bytes:]
    assert sha(original) == metadata["sha256"]
    return original, metadata, body, pixels


BOOT = r"""async () => {
  window.saIdentities=new Map();window.saPending=new Map();window.saCounter=0;
  window.saWorker=new Worker('/secure-worker.js',{type:'module'});
  window.saWorker.onmessage=({data})=>{
    if(data.type==='progress'||data.type==='ready')return;
    const p=window.saPending.get(data.id);if(!p)return;clearTimeout(p.timer);window.saPending.delete(data.id);p.resolve(data);
  };
  window.saWorker.onerror=e=>{for(const p of window.saPending.values()){clearTimeout(p.timer);p.reject(new Error(e.message));}window.saPending.clear();};
  window.saCall=input=>new Promise((resolve,reject)=>{const id='secure-audit-'+(++window.saCounter);const timer=setTimeout(()=>reject(new Error('Secure worker timeout')),180000);window.saPending.set(id,{resolve,reject,timer});window.saWorker.postMessage({...input,id});});
  return await window.saCall({action:'decode',artwork:new ArrayBuffer(0),token:'{}',secret:'bad'});
}"""

CALL = r"""async input => {
  const from64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)).buffer;
  const to64=a=>{const b=new Uint8Array(a);let s='';for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(s);};
  const identityLabel=input.identityLabel;delete input.identityLabel;
  const identityRef=input.identityRef;delete input.identityRef;
  const summaryOnly=input.summaryOnly;delete input.summaryOnly;
  if(identityRef){const identity=window.saIdentities.get(identityRef);input.privateKey=identity.privateKey;input.recipientPublic=identity.publicBundle;}
  for(const k of ['file','artwork','token'])if(input[k]!==undefined)input[k]=from64(input[k]);
  if(input.cover&&typeof input.cover.data==='string')input.cover.data=from64(input.cover.data);
  if(input.fileSpec){input.file=new Uint8Array(input.fileSpec.bytes).fill(input.fileSpec.fill||0).buffer;delete input.fileSpec;}
  if(input.coverSpec){const s=input.coverSpec;delete input.coverSpec;const data=new Uint8Array(s.width*s.height*3);for(let y=0;y<s.height;y++)for(let x=0;x<s.width;x++){const i=(y*s.width+x)*3;data[i]=(x*3+y+s.seed)%256;data[i+1]=(x+y*2+s.seed*3)%256;data[i+2]=(x*2+y*3+s.seed*7)%256;}input.cover={width:s.width,height:s.height,channels:3,data:data.buffer};}
  const result=await window.saCall(input);
  if(result.privateKey&&identityLabel)window.saIdentities.set(identityLabel,result);
  if(summaryOnly&&result.artwork){const v=new DataView(result.artwork);return {type:result.type,width:v.getUint32(16),height:v.getUint32(20),artwork_bytes:result.artwork.byteLength,...Object.fromEntries(Object.entries(result).filter(([k,v])=>!(v instanceof ArrayBuffer)&&k!=='privateKey'))};}
  const normalize=v=>v instanceof CryptoKey?{type:v.type,extractable:v.extractable,algorithm:v.algorithm,usages:v.usages}:v instanceof ArrayBuffer?to64(v):Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)])):v;
  return normalize(result);
}"""


def call(page, action, **values): return page.evaluate(CALL, {"action": action, **values})
def successful(reply):
    assert reply.get("type") == "result", str(reply)
    return reply
def rejected(reply): assert reply.get("type") == "error", str(reply)


def crypto_vectors(page):
    key = bytes.fromhex("FEFFE9928665731C6D6A8F9467308308" * 2)
    iv = bytes.fromhex("CAFEBABEFACEDBADDECAF888")
    plain = bytes.fromhex("D9313225F88406E5A55909C5AFF5269A86A7A9531534F7DA2E4C303D8A318A721C3C0C95956809532FCF0E2449A6B525B16AEDF5AA0DE657BA637B391AAFD255")
    expected = bytes.fromhex("522DC1F099567D07F47F37A32A84427D643A8CDCBFE5C0C97598A2BD2555D1AA8CB08E48590DBB3DA7B08B1056828838C5F61E6393BA7A0ABCC9F662898015ADB094DAC5D93471BDEC1A502270E3CC6C")
    assert AESGCM(key).encrypt(iv, plain, None) == expected
    actual = page.evaluate("""async v=>{const b=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const key=await crypto.subtle.importKey('raw',b(v.key),'AES-GCM',false,['encrypt']);const result=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:b(v.iv),tagLength:128},key,b(v.plain)));return Array.from(result,x=>x.toString(16).padStart(2,'0')).join('');}""", {"key": b64(key), "iv": b64(iv), "plain": b64(plain)})
    assert actual == expected.hex()
    ikm, salt, info = bytes([11])*22, bytes(range(13)), bytes(range(240, 250))
    expected_hkdf = bytes.fromhex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
    assert HKDF(algorithm=hashes.SHA256(), length=42, salt=salt, info=info).derive(ikm) == expected_hkdf
    actual = page.evaluate("""async v=>{const b=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const key=await crypto.subtle.importKey('raw',b(v.ikm),'HKDF',false,['deriveBits']);const result=new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:b(v.salt),info:b(v.info)},key,336));return Array.from(result,x=>x.toString(16).padStart(2,'0')).join('');}""", {"ikm": b64(ikm), "salt": b64(salt), "info": b64(info)})
    assert actual == expected_hkdf.hex()


def cover_array(width, height, seed):
    y, x = np.indices((height, width), dtype=np.uint32)
    return np.stack(((x*3+y+seed)%256, (x+y*2+seed*3)%256, (x*2+y*3+seed*7)%256), axis=2).astype(np.uint8)


def run(args):
    OUT.mkdir(exist_ok=True)
    manifest = json.loads((FIXTURES / "manifest.json").read_text("utf-8"))
    results = []
    def passed(name, **detail):
        results.append({"test": name, "passed": True, **detail})
        print("PASS " + name, flush=True)
    start = time.monotonic()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        sender_context, receiver_context = browser.new_context(), browser.new_context()
        sender, receiver = sender_context.new_page(), receiver_context.new_page()
        response_security_headers={}
        for page in (sender, receiver):
            response = page.goto(args.base_url, wait_until="networkidle")
            assert response.status == 200
            response_security_headers={k:v for k,v in response.all_headers().items() if k in (
                'content-security-policy','x-content-type-options','referrer-policy','permissions-policy',
                'strict-transport-security','x-frame-options','cross-origin-opener-policy')}
            page.evaluate(BOOT)
        crypto_vectors(sender)
        passed("NIST AES-256-GCM and RFC5869 HKDF vectors in Python and native WebCrypto")
        receiver_context.set_offline(True)
        receiver_context.route("**/*", lambda route: route.abort())
        secret = u64(bytes(range(32)))  # Synthetic test-only secret; never an application default.
        generated = []
        for fixture in manifest:
            source = (FIXTURES / fixture["kind"] / "original.bin").read_bytes()
            reply = successful(call(sender, "encode", file=b64(source), name=fixture["filename"], mime=fixture["mime"],
                                    secret=secret, mode="secret", coverSpec={"width":256,"height":192,"seed":17}))
            art, token = unb64(reply["artwork"]), unb64(reply["token"])
            original, metadata, body, pixels = oracle(art, token, secret=reply.get("recovery_secret", secret))
            assert original == source and metadata["name"] == fixture["filename"]
            decoded = successful(call(receiver, "decode", artwork=b64(art), token=b64(token), secret=reply.get("recovery_secret", secret)))
            assert unb64(decoded["file"]) == source
            cover = cover_array(256,192,17)
            delta = np.abs(pixels.astype(np.int16)-cover.astype(np.int16))
            assert int(delta.max()) <= (1 << body["bits"])-1
            assert np.array_equal(pixels >> body["bits"], cover >> body["bits"])
            assert fixture["filename"].encode("utf-8") not in token and fixture["original_sha256"].encode() not in token
            assert b'"name"' not in token and b'"mime"' not in token and b'"sha256"' not in token
            generated.append((source, reply, art, token, body))
            (OUT / (fixture["kind"]+".png")).write_bytes(art)
            (OUT / (fixture["kind"]+".json")).write_bytes(token)
            passed("Independent AES/HKDF/LSB + offline exact " + fixture["kind"], bits=body["bits"],
                   max_channel_delta=int(delta.max()), token_bytes=len(token), original_sha256=sha(source))
        source, reply, art, token_bytes, body = generated[0]
        # Correctly shaped tampering distinguishes authenticated binding from
        # format rejection; the known secret below belongs only to test data.
        token = json.loads(token_bytes)
        wrong = u64(bytes([255])*32)
        rejected(call(receiver,"decode",artwork=b64(art),token=b64(token_bytes),secret=wrong))
        rejected(call(receiver,"decode",artwork=b64(art),token=b64(token_bytes)))
        passed("Wrong and missing recovery secrets rejected")
        variants = {}
        for field in ("payload_iv","token_iv","salt","encrypted_body"):
            changed = dict(token)
            raw = bytearray(unu64(changed[field])); raw[0] ^= 1; changed[field] = u64(raw)
            variants[field] = canonical(changed)
        variants["unknown_header_field"] = canonical({**token,"unrecognized":"test"})
        variants["duplicate_JSON_key"] = b'{"format":"ASTRA-SECURE-V2",'+token_bytes.strip()[1:]
        variants["oversized_token"] = b" "*16385
        variants["same_IV"] = canonical({**token,"token_iv":token["payload_iv"]})
        for label, variant in variants.items():
            rejected(call(receiver,"decode",artwork=b64(art),token=b64(variant),secret=secret))
        passed("Header AAD, encrypted token, duplicate/unknown fields, IV and size tampering rejected", cases=list(variants))
        changed = Image.open(io.BytesIO(art)); changed.load()
        p = changed.getpixel((0,0)); changed.putpixel((0,0),((p[0]+1)%256,p[1],p[2]))
        out = io.BytesIO(); changed.save(out,"PNG")
        rejected(call(receiver,"decode",artwork=b64(out.getvalue()),token=b64(token_bytes),secret=secret))
        rejected(call(receiver,"decode",artwork=b64(generated[1][2]),token=b64(token_bytes),secret=secret))
        passed("Changed PNG and artwork/token substitution rejected")
        header={k:v for k,v in token.items() if k!='encrypted_body'}
        token_key=derive(unu64(secret),unu64(token['salt']),'token')
        for field,value in (("width",4097),("bits",0),("bits",5),("ciphertext_bytes",999999999)):
            altered_body={**body,field:value}
            altered_token={**token,"encrypted_body":u64(AESGCM(token_key).encrypt(unu64(token['token_iv']),canonical(altered_body),canonical(header)))}
            rejected(call(receiver,"decode",artwork=b64(art),token=b64(canonical(altered_token)),secret=secret))
        passed("Authenticated but out-of-bounds body fields rejected")
        repeat=successful(call(sender,"encode",file=b64(source),name=manifest[0]['filename'],mime=manifest[0]['mime'],secret=secret,
                               coverSpec={"width":256,"height":192,"seed":17}))
        repeated_token=json.loads(unb64(repeat['token']))
        assert all(repeated_token[k]!=token[k] for k in ('salt','payload_iv','token_iv'))
        assert unb64(repeat['artwork'])!=art and unb64(repeat['token'])!=token_bytes
        passed("Repeated plaintext with same secret creates fresh salts, IVs, PNG and token")
        automatic=[]
        for _ in range(2):
            item=successful(call(sender,"encode",file=b64(b'private test'),name='test.txt',mime='text/plain',coverSpec={"width":32,"height":32,"seed":3}))
            assert len(unu64(item['recovery_secret']))==32
            assert item['recovery_secret'].encode() not in unb64(item['token'])
            automatic.append(item['recovery_secret'])
        assert automatic[0]!=automatic[1]
        passed("Separate automatically generated 256-bit secrets are not in tokens")
        bit_counts=[]
        for amount in (200,400,800,1100):
            contents=b'X'*amount
            item=successful(call(sender,"encode",file=b64(contents),name='bits.txt',mime='text/plain',secret=secret,
                                 coverSpec={"width":32,"height":32,"seed":3}))
            recovered,_,parameters,pixels=oracle(unb64(item['artwork']),unb64(item['token']),secret=secret)
            assert recovered==contents
            expected_bits=math.ceil(parameters['ciphertext_bytes']*8/(32*32*3))
            assert parameters['bits']==expected_bits
            assert int(np.abs(pixels.astype(np.int16)-cover_array(32,32,3).astype(np.int16)).max())<=(1<<expected_bits)-1
            bit_counts.append(expected_bits)
        assert bit_counts==[1,2,3,4],bit_counts
        passed("All 1/2/3/4-bit capacity selections, extraction and pixel error bounds",bits_tested=bit_counts)
        negative_inputs=[
            {"file":b64(b'')},
            {"fileSpec":{"bytes":20*1024*1024+1}},
            {"file":b64(b'X'*2000),"coverSpec":{"width":32,"height":32,"seed":1}},
            {"file":b64(b'X'),"cover":{"width":4097,"height":1,"channels":3,"data":b64(b'123')}}]
        for values in negative_inputs:
            base={"name":"test.txt","mime":"text/plain","coverSpec":{"width":32,"height":32,"seed":1},**values}
            if 'cover' in base:base.pop('coverSpec')
            rejected(call(sender,"encode",**base))
        passed("Empty/oversize files, insufficient carrier and side bound rejected")
        # A Python-only test key provides an independent recipient ECDH oracle.
        private=ec.generate_private_key(ec.SECP256R1());numbers=private.private_numbers();pub=numbers.public_numbers
        jwk={"crv":"P-256","kty":"EC","x":u64(pub.x.to_bytes(32,'big')),"y":u64(pub.y.to_bytes(32,'big'))}
        bundle={"format":"ASTRA-RECIPIENT-V1","publicKey":jwk,"fingerprint":sha(canonical(jwk))}
        private_jwk={**jwk,"d":u64(numbers.private_value.to_bytes(32,'big')),"key_ops":["deriveBits"],"ext":False}
        receiver.evaluate("""async v=>{const privateKey=await crypto.subtle.importKey('jwk',v.jwk,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);window.saIdentities.set('python',{privateKey,publicBundle:v.bundle});}""",{"jwk":private_jwk,"bundle":bundle})
        recipient_item=successful(call(sender,"encode",file=b64(source),name=manifest[0]['filename'],mime=manifest[0]['mime'],recipient=bundle,
                                       coverSpec={"width":256,"height":192,"seed":17}))
        assert not recipient_item.get('recovery_secret')
        recipient_art,recipient_token=unb64(recipient_item['artwork']),unb64(recipient_item['token'])
        recovered,_,_,_=oracle(recipient_art,recipient_token,private_key=private)
        assert recovered==source
        restored=successful(call(receiver,"decode",artwork=b64(recipient_art),token=b64(recipient_token),identityRef='python'))
        assert unb64(restored['file'])==source
        passed("Independent Python P-256 ECDH + HKDF + AES-GCM recipient decryption")
        own=successful(call(receiver,'generate_identity',identityLabel='own'))
        assert own['privateKey']['extractable'] is False
        export_refused=receiver.evaluate("""async()=>{const k=window.saIdentities.get('own').privateKey;try{await crypto.subtle.exportKey('jwk',k);return false;}catch{return true;}}""")
        assert export_refused
        rejected(call(receiver,'decode',artwork=b64(recipient_art),token=b64(recipient_token),identityRef='own'))
        passed("Nonextractable private identity and wrong-recipient rejection")
        clone_ok=receiver.evaluate("""()=>{const original=window.saIdentities.get('own');const clone=structuredClone(original);window.saIdentities.set('clone',clone);return clone.privateKey.extractable===false&&clone.privateKey.type==='private';}""")
        assert clone_ok
        cloned_item=successful(call(sender,'encode',file=b64(source),name='clone.png',mime='image/png',recipient=own['publicBundle'],coverSpec={"width":256,"height":192,"seed":4}))
        cloned_restored=successful(call(receiver,'decode',artwork=cloned_item['artwork'],token=cloned_item['token'],identityRef='clone'))
        assert unb64(cloned_restored['file'])==source
        passed("Structured-cloned nonextractable private key still decrypts")
        bad_bundle={**bundle,'fingerprint':'0'*64}
        rejected(call(sender,'encode',file=b64(source),name='test.png',mime='image/png',recipient=bad_bundle,coverSpec={"width":256,"height":192,"seed":1}))
        passed("Recipient public-key fingerprint mismatch rejected")
        other_cover=successful(call(sender,'encode',file=b64(source),name='cover.png',mime='image/png',secret=secret,
                                     coverSpec={"width":256,"height":192,"seed":201}))
        _,_,other_body,other_pixels=oracle(unb64(other_cover['artwork']),unb64(other_cover['token']),secret=secret)
        assert np.array_equal(other_pixels>>other_body['bits'],cover_array(256,192,201)>>other_body['bits'])
        assert not np.array_equal(other_pixels>>4,cover_array(256,192,17)>>4)
        passed("Different custom cover controls visible artwork high bits")
        # A genuinely fresh same-origin context stores its key in IndexedDB,
        # reloads, and decrypts using the persisted nonextractable CryptoKey.
        identity_context=browser.new_context()
        identity_page=identity_context.new_page()
        identity_page.goto(args.base_url,wait_until='networkidle')
        identity_record=identity_page.evaluate("""async()=>{const store=await import('/identity-store.js');const identity=await store.createIdentity();return {publicBundle:identity.publicBundle,extractable:identity.privateKey.extractable,exported:await store.exportPublicIdentity(identity)};}""")
        assert identity_record['extractable'] is False
        exported=json.loads(identity_record['exported'])
        assert set(exported)=={'format','publicKey','fingerprint'} and 'd' not in exported['publicKey']
        stored_bundle=identity_record['publicBundle']
        assert sha(canonical(stored_bundle['publicKey']))==stored_bundle['fingerprint']
        identity_page.reload(wait_until='networkidle')
        identity_page.evaluate(BOOT)
        reloaded=identity_page.evaluate("""async()=>{const store=await import('/identity-store.js');window.saStore=store;const record=await store.loadIdentity();window.saIdentities.set('stored',record);let refused=false;try{await crypto.subtle.exportKey('jwk',record.privateKey);}catch{refused=true;}return {fingerprint:record.publicBundle.fingerprint,extractable:record.privateKey.extractable,exportRefused:refused};}""")
        assert reloaded=={'fingerprint':stored_bundle['fingerprint'],'extractable':False,'exportRefused':True}
        identity_context.set_offline(True)
        stored_message=successful(call(sender,'encode',file=b64(source),name='idb.png',mime='image/png',recipient=stored_bundle,
                                        coverSpec={"width":256,"height":192,"seed":19}))
        restored=successful(call(identity_page,'decode',artwork=stored_message['artwork'],token=stored_message['token'],identityRef='stored'))
        assert unb64(restored['file'])==source
        passed("IndexedDB key survives reload, refuses export, and decrypts offline")
        pairing_rejected=identity_page.evaluate("""async wrong=>{const record=window.saIdentities.get('stored');await new Promise((resolve,reject)=>{const r=indexedDB.open('astra-private-identities-v1',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('identities','readwrite');tx.objectStore('identities').put({...record,publicBundle:wrong},'current');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};r.onerror=reject;});try{await window.saStore.loadIdentity();return false;}catch{return true;}}""",own['publicBundle'])
        assert pairing_rejected
        passed("Corrupted stored public/private identity pairing is detected")
        identity_context.close()
        # Dimensions are inspected from the produced PNG IHDR, not UI labels.
        large=successful(call(sender,'encode',file=b64(b'4K dimensions audit'),name='4k.txt',mime='text/plain',summaryOnly=True,
                              coverSpec={"width":3840,"height":2160,"seed":11}))
        assert (large['width'],large['height'])==(3840,2160) and large['artwork_bytes']>3840*2160*3
        passed("Actual 3840 x 2160 PNG output",width=large['width'],height=large['height'],png_bytes=large['artwork_bytes'])
        browser.close()
    report = {"status":"PASS","base_url":args.base_url,"seconds":round(time.monotonic()-start,3),
              "checks":results,"browser":"Microsoft Edge","oracle":"Python cryptography AESGCM/HKDF/ECDH; NumPy/Pillow LSB extraction",
              "response_security_headers":response_security_headers,
              "cryptographic_reference_sources":["https://www.rfc-editor.org/rfc/rfc5869","https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Standards-and-Guidelines/documents/examples/AES_GCM.pdf","https://www.w3.org/TR/webcrypto/"]}
    (ROOT / "SECURITY_TEST_REPORT.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"status":"PASS","checks":len(results),"seconds":report["seconds"]}))


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base-url",default="http://127.0.0.1:8770")
    run(p.parse_args())
