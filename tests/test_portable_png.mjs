import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {encodeSecure,decodeSecure,generateIdentity,estimateCiphertextBytes} from '../public/secure-worker.js';
import {packPortablePNG,unpackPortablePNG,extractEmbeddedToken,MAX_EMBEDDED_TOKEN_BYTES} from '../public/portable-png.js';

const start=performance.now(),checks=[];
const pass=name=>checks.push({name,pass:true});
const bytes=value=>new Uint8Array(value);
const same=(a,b)=>assert.deepEqual(bytes(a),bytes(b));
const text=new TextEncoder(),decode=new TextDecoder();
async function sha(data){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');}
function chunks(raw){const data=bytes(raw),v=new DataView(data.buffer,data.byteOffset,data.byteLength);let p=8;const out=[];while(p<data.length){const length=v.getUint32(p);out.push({offset:p,start:p+8,length,end:p+length+12,type:String.fromCharCode(...data.subarray(p+4,p+8))});p+=length+12;}return out;}
function crc(data,start,end){let c=0xffffffff;for(let p=start;p<end;p++){c^=data[p];for(let b=0;b<8;b++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return(c^0xffffffff)>>>0;}
function fixCRC(data,entry){new DataView(data.buffer).setUint32(entry.start+entry.length,crc(data,entry.offset+4,entry.start+entry.length));}
function join(...arrays){const result=new Uint8Array(arrays.reduce((n,a)=>n+a.length,0));let p=0;for(const array of arrays){result.set(array,p);p+=array.length;}return result;}
const original=Uint8Array.from({length:8193},(_,i)=>(i*109+33)%256);
const cover={width:512,height:384,channels:3,data:Uint8Array.from({length:512*384*3},(_,i)=>90+Math.floor(i/1536)%80)};
const input={file:original,name:'nota-café-🌄.bin',mime:'application/octet-stream',cover,embed_token:true};
const encoded=await encodeSecure(input),portable=bytes(encoded.artwork),token=bytes(encoded.token),parts=chunks(portable);
assert.deepEqual(parts.map(c=>c.type),['IHDR','IDAT','neBo','IEND']);assert(encoded.embedded_token);
const unpacked=unpackPortablePNG(portable);same(unpacked.token,token);same(extractEmbeddedToken(portable),token);same(packPortablePNG(unpacked.artwork,token),portable);
pass('one_private_ancillary_token_chunk_exact_pack_unpack');
const restored=await decodeSecure({artwork:portable,secret:encoded.recovery_secret});same(restored.file,original);assert(restored.embedded_token);pass('png_and_secret_only_exact_file_recovery');
same((await decodeSecure({artwork:portable,token,secret:encoded.recovery_secret})).file,original);pass('matching_external_token_copy_accepted');
assert.equal(encoded.artwork_sha256,await sha(portable));assert.equal(encoded.base_artwork_sha256,await sha(unpacked.artwork));assert.notEqual(encoded.artwork_sha256,encoded.base_artwork_sha256);pass('delivered_artifact_hash_separate_from_authenticated_base_hash');
assert.equal(estimateCiphertextBytes(input),encoded.ciphertext_bytes);assert.equal(estimateCiphertextBytes({file:{size:original.length},name:input.name,mime:input.mime}),encoded.ciphertext_bytes);assert.equal(estimateCiphertextBytes({file:new File([original],input.name,{type:input.mime})}),encoded.ciphertext_bytes);pass('exact_frame_estimator_unicode_and_file_like_without_read');
assert.equal(encoded.png_compression,'deflate');assert(unpacked.artwork.length<encoded.uncompressed_png_bytes/2);assert(encoded.png_savings_bytes>0);pass('actual_lossless_deflate_smaller_than_stored_upper_bound');
const secret=encoded.recovery_secret;assert(!decode.decode(token).includes(secret));assert(!decode.decode(token).includes(input.name));assert(!decode.decode(token).includes(encoded.source_sha256));pass('embedded_token_contains_no_recovery_secret_name_or_original_hash');
await assert.rejects(()=>decodeSecure({artwork:portable,secret:'A'.repeat(43)}),e=>e.code==='AUTHENTICATION');await assert.rejects(()=>decodeSecure({artwork:portable}),e=>e.code==='KEY_REQUIRED');pass('wrong_or_missing_secret_rejected');
await assert.rejects(()=>decodeSecure({artwork:portable,token:text.encode(decode.decode(token).trim()),secret}),e=>e.code==='TOKEN_MISMATCH');pass('external_internal_token_byte_disagreement_rejected');
const chunk=parts.find(c=>c.type==='neBo');let bad=portable.slice();bad[chunk.start+30]^=1;assert.throws(()=>unpackPortablePNG(bad),/CRC/);pass('token_chunk_corruption_detected_before_decryption');
const malformedUTF8=portable.slice();malformedUTF8[chunk.start]=255;fixCRC(malformedUTF8,chunk);assert.throws(()=>extractEmbeddedToken(malformedUTF8),/UTF-8/);pass('invalid_utf8_even_with_repaired_crc_rejected');
const changed=JSON.parse(decode.decode(token));changed.encrypted_body=(changed.encrypted_body[0]==='A'?'B':'A')+changed.encrypted_body.slice(1);const changedPortable=packPortablePNG(unpacked.artwork,text.encode(JSON.stringify(changed)));await assert.rejects(()=>decodeSecure({artwork:changedPortable,secret}),e=>e.code==='AUTHENTICATION');pass('edited_token_with_valid_png_crc_fails_aead');
const other=await encodeSecure(input);await assert.rejects(()=>decodeSecure({artwork:packPortablePNG(unpacked.artwork,other.token),secret:other.recovery_secret}),e=>e.code==='ARTWORK_INTEGRITY');pass('replacement_valid_token_bound_to_other_base_png_rejected');
const duplicate=join(portable.subarray(0,chunk.end),portable.subarray(chunk.offset,chunk.end),portable.subarray(chunk.end));assert.throws(()=>unpackPortablePNG(duplicate),/duplicados/);assert.throws(()=>packPortablePNG(portable,token),/ya contiene/);pass('duplicate_or_nested_embedded_token_rejected');
await assert.rejects(()=>decodeSecure({artwork:unpacked.artwork,secret}),e=>e.code==='TOKEN_REQUIRED');same((await decodeSecure({artwork:unpacked.artwork,token,secret})).file,original);pass('removal_requires_external_token_legacy_pair_remains_valid');
assert.equal(extractEmbeddedToken(unpacked.artwork),null);same(unpackPortablePNG(unpacked.artwork).artwork,unpacked.artwork);pass('legacy_base_png_returned_byte_identically_without_token');
assert.throws(()=>packPortablePNG(unpacked.artwork,new Uint8Array(MAX_EMBEDDED_TOKEN_BYTES+1)));assert.throws(()=>unpackPortablePNG(portable.subarray(0,-1)));bad=portable.slice();new DataView(bad.buffer).setUint32(chunk.offset,0xffffffff);assert.throws(()=>unpackPortablePNG(bad));pass('token_quota_truncation_and_declared_length_overflow_rejected');
const unknown=portable.slice();unknown[chunk.offset+5]='x'.charCodeAt(0);fixCRC(unknown,chunk);assert.throws(()=>unpackPortablePNG(unknown),/no admitido/);const leaked=JSON.parse(decode.decode(token));leaked.recovery_secret=secret;assert.throws(()=>packPortablePNG(unpacked.artwork,text.encode(JSON.stringify(leaked))),/campos adicionales/);pass('unknown_chunks_and_plaintext_secret_token_fields_rejected');
const pixelTamper=unpacked.artwork.slice(),idat=chunks(pixelTamper).find(c=>c.type==='IDAT');pixelTamper[idat.start+5]^=1;fixCRC(pixelTamper,idat);await assert.rejects(()=>decodeSecure({artwork:packPortablePNG(pixelTamper,token),secret}),e=>e.code==='ARTWORK_INTEGRITY');pass('changed_base_png_rejected_even_with_repaired_crc');
const nativeCompression=globalThis.CompressionStream;let stored;
try{globalThis.CompressionStream=undefined;stored=await encodeSecure({...input,embed_token:false});}finally{globalThis.CompressionStream=nativeCompression;}
assert.equal(stored.png_compression,'stored');assert.equal(stored.artwork_bytes,stored.uncompressed_png_bytes);assert.equal(stored.embedded_token,false);same((await decodeSecure({artwork:stored.artwork,token:stored.token,secret:stored.recovery_secret})).file,original);pass('stored_deflate_fallback_and_old_external_pair_compatible');
const identity=await generateIdentity(),recipient=await encodeSecure({...input,recipient:identity.publicBundle});assert.equal(recipient.recovery_secret,undefined);same((await decodeSecure({artwork:recipient.artwork,privateKey:identity.privateKey,recipientPublic:identity.publicBundle})).file,original);pass('recipient_identity_mode_png_only_roundtrip');

// Independent native zlib + Pillow oracle artifacts. No recovery key is saved.
const baseChunks=chunks(unpacked.artwork),baseIDAT=baseChunks.find(c=>c.type==='IDAT');const inflated=inflateSync(unpacked.artwork.subarray(baseIDAT.start,baseIDAT.start+baseIDAT.length));const rgb=new Uint8Array(cover.width*cover.height*3),stride=cover.width*3+1;for(let y=0;y<cover.height;y++){assert.equal(inflated[y*stride],0);rgb.set(inflated.subarray(y*stride+1,(y+1)*stride),y*cover.width*3);}pass('independent_node_zlib_reads_compressed_scanlines');
const out=new URL('./portable_artifacts/',import.meta.url);await mkdir(out,{recursive:true});await writeFile(new URL('portable.png',out),portable);await writeFile(new URL('base.png',out),unpacked.artwork);await writeFile(new URL('expected.rgb',out),rgb);await writeFile(new URL('metadata.json',out),JSON.stringify({width:cover.width,height:cover.height,pixel_sha256:await sha(rgb),base_sha256:encoded.base_artwork_sha256,portable_sha256:encoded.artwork_sha256}));
const report={status:'PASS',checks:checks.length,results:checks,portable_bytes:portable.length,base_png_bytes:unpacked.artwork.length,token_bytes:token.length,stored_png_upper_bound:encoded.uncompressed_png_bytes,compression:encoded.png_compression,seconds:Number(((performance.now()-start)/1000).toFixed(3))};await writeFile(new URL('./PORTABLE_CODEC_REPORT.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
