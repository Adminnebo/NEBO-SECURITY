import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createBundle,readBundle,estimateBundleSize,isBundleMime,BUNDLE_MIME,MAX_BUNDLE_BYTES,MAX_BUNDLE_ITEMS} from '../public/bundle.js';
import {encodeSecure,decodeSecure} from '../public/secure-worker.js';

const checks=[],started=performance.now();
const mark=name=>checks.push({name,pass:true});
const same=(a,b)=>assert.deepEqual(new Uint8Array(a),new Uint8Array(b));
const utf8=new TextEncoder();
const binary=Uint8Array.from({length:2049},(_,i)=>(i*137)%256);
const text=utf8.encode('Mensaje íntegro: café, montaña, 签名 y 🌄.\nSegunda línea.');
const geo=utf8.encode(JSON.stringify({type:'Feature',geometry:{type:'Point',coordinates:[-70.64,19.12]},properties:{label:'Jarabacoa, República Dominicana'}}));
const voice=new Uint8Array([82,73,70,70,0,0,0,0,87,65,86,69,0,255,13,10]);
const items=[
  {file:new File([binary],'foto-🌄.png',{type:'image/png',lastModified:1}),kind:'file'},
  {file:new File([text],'foto-🌄.png',{type:'text/plain;charset=utf-8',lastModified:999}),kind:'text'},
  {file:new File([voice],'nota.wav',{type:'audio/wav'}),kind:'voice'},
  {file:new File([geo],'ubicación.geojson',{type:'application/geo+json'}),kind:'location'},
  {file:new File([],'vacío.txt',{type:'text/plain'}),kind:'file'},
  {file:new File([text],'../../CON.txt',{type:'text/plain'}),kind:'text'},
  {file:new File([text],'cafe\u0301.txt',{type:'text/plain'}),kind:'text'}
];
const file=await createBundle(items),raw=new Uint8Array(await file.arrayBuffer()),restored=await readBundle(raw);
assert.equal(file.name,'NEBO-envio.zip');assert.equal(file.type,BUNDLE_MIME);assert.equal(file.lastModified,0);
assert.equal(file.size,estimateBundleSize(items));assert.equal(restored.length,items.length);
for(let i=0;i<items.length;i++){same(restored[i].bytes,await items[i].file.arrayBuffer());assert.equal(restored[i].kind,items[i].kind);assert.match(restored[i].sha256,/^[0-9a-f]{64}$/);}
mark('mixed_file_text_voice_location_byte_exact_roundtrip');
assert.equal(restored[0].name,restored[1].name);assert.equal(restored[0].name,'foto-🌄.png');
assert.equal(restored[5].name,'_CON.txt');assert.equal(restored[6].name,'café.txt');
mark('duplicate_human_names_indexed_unicode_nfc_and_safe_names');
assert.equal(restored[4].bytes.length,0);assert.equal(restored[4].sha256,'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
mark('empty_file_preserved_with_standard_sha256');
const again=await createBundle(items);same(raw,await again.arrayBuffer());
mark('deterministic_zip_and_exact_sync_size_estimator');
assert(isBundleMime(BUNDLE_MIME.toUpperCase()+'; ignored=value'));assert(!isBundleMime('application/zip'));assert(!isBundleMime(null));
mark('bundle_mime_detection');
const uncommon=await createBundle([{file:new File([voice],'audio.webm',{type:'audio/webm;codecs=opus'}),kind:'voice'},{file:new File([binary],'unknown.bin',{type:'invalid mime value'}),kind:'file'}]);
const uncommonRecovered=await readBundle(await uncommon.arrayBuffer());assert.equal(uncommonRecovered[0].mime,'audio/webm');assert.equal(uncommonRecovered[1].mime,'application/octet-stream');same(uncommonRecovered[0].bytes,voice);same(uncommonRecovered[1].bytes,binary);mark('mime_parameters_stripped_invalid_mime_falls_back_without_data_change');
const fromView=await readBundle(new DataView(raw.buffer,raw.byteOffset,raw.byteLength));same(fromView[0].bytes,binary);
mark('arraybuffer_and_typed_view_inputs');

const cover={width:256,height:256,channels:3,data:Uint8Array.from({length:256*256*3},(_,i)=>(i*53)%256).buffer};
const secured=await encodeSecure({file:raw,name:file.name,mime:BUNDLE_MIME,cover});
await assert.rejects(()=>decodeSecure({artwork:secured.artwork,token:secured.token,secret:'A'.repeat(43)}),/autenticar/);
const unsealed=await decodeSecure({artwork:secured.artwork,token:secured.token,secret:secured.recovery_secret});same(unsealed.file,raw);assert.equal(unsealed.mime,BUNDLE_MIME);assert.equal(unsealed.name,'NEBO-envio.zip');
const securedItems=await readBundle(unsealed.file);for(let i=0;i<items.length;i++){same(securedItems[i].bytes,await items[i].file.arrayBuffer());assert.equal(securedItems[i].sha256,restored[i].sha256);}
mark('mixed_zip_secure_encrypt_decrypt_all_files_and_hashes_exact_wrong_secret_rejected');

function records(data){const v=new DataView(data.buffer,data.byteOffset,data.byteLength),end=data.length-22,count=v.getUint16(end+10,true);let p=v.getUint32(end+16,true);const result=[];for(let i=0;i<count;i++){const local=v.getUint32(p+42,true),nameLength=v.getUint16(p+28,true),size=v.getUint32(p+24,true);result.push({central:p,local,nameLength,size,start:local+30+nameLength});p+=46+nameLength;}return result;}
const structures=records(raw);
function crc32(data){let value=0xffffffff;for(const byte of data){value^=byte;for(let k=0;k<8;k++)value=value&1?(value>>>1)^0xedb88320:value>>>1;}return(value^0xffffffff)>>>0;}
function repairCRC(data,entry){const crc=crc32(data.subarray(entry.start,entry.start+entry.size)),v=new DataView(data.buffer);v.setUint32(entry.local+14,crc,true);v.setUint32(entry.central+16,crc,true);}
async function rejects(name,change,pattern){const altered=raw.slice();change(altered,new DataView(altered.buffer));await assert.rejects(()=>readBundle(altered),pattern);mark(name);}
await rejects('payload_corruption_crc_rejected',b=>b[structures[1].start]^=1,/CRC/);
await rejects('modified_payload_even_with_repaired_crc_rejected_by_sha256',b=>{b[structures[1].start]^=1;repairCRC(b,structures[1]);},/SHA-256/);
await assert.rejects(()=>readBundle(raw.subarray(0,-1)));mark('truncated_archive_rejected');
await rejects('overlapping_local_offsets_rejected',(_b,v)=>v.setUint32(structures[2].central+42,structures[1].local,true),/posicion/);
await rejects('compression_and_bomb_profile_rejected',(_b,v)=>{v.setUint16(structures[1].central+10,8,true);v.setUint16(structures[1].local+8,8,true);},/STORE/);
await rejects('encrypted_zip_profile_rejected',(_b,v)=>v.setUint16(structures[1].central+8,0x801,true),/STORE/);
await rejects('invalid_utf8_filename_rejected',(b)=>{b[structures[1].central+46]=255;b[structures[1].local+30]=255;},/UTF-8/);
await rejects('duplicate_zip_entry_paths_rejected',(b)=>{const first=structures[1],second=structures[2];assert.equal(first.nameLength,second.nameLength);b.set(b.subarray(first.central+46,first.central+46+first.nameLength),second.central+46);b.set(b.subarray(first.local+30,first.local+30+first.nameLength),second.local+30);},/duplicados/);
await rejects('traversal_path_rejected',(b)=>{const entry=structures[1];b.set(utf8.encode('../x//'),entry.central+46);b.set(utf8.encode('../x//'),entry.local+30);},/ruta/);
await rejects('central_directory_range_rejected',(_b,v)=>v.setUint32(raw.length-22+16,0xffffffff,true),/limites/);
await rejects('zip_attributes_and_links_rejected',(_b,v)=>v.setUint32(structures[1].central+38,0xa1ff0000,true),/atributos/);
await rejects('manifest_unknown_format_rejected',(b)=>{const entry=structures[0];const marker=utf8.encode('NEBO-BUNDLE-V1');let found=-1;for(let p=entry.start;p<entry.start+entry.size-marker.length;p++)if(marker.every((x,i)=>b[p+i]===x)){found=p;break;}assert(found>=0);b[found]='X'.charCodeAt(0);repairCRC(b,entry);},/manifiesto/);

const one=()=>({file:new File([],'vacio.bin',{type:'application/octet-stream'}),kind:'file'});
await assert.rejects(()=>createBundle([]));assert.throws(()=>estimateBundleSize(Array.from({length:33},one)));mark('empty_bundle_and_over_32_items_rejected');
const thirtyTwo=Array.from({length:MAX_BUNDLE_ITEMS},one),fullCount=await createBundle(thirtyTwo);assert.equal((await readBundle(await fullCount.arrayBuffer())).length,32);mark('32_empty_files_accepted');
await assert.rejects(()=>readBundle(new Uint8Array(MAX_BUNDLE_BYTES+1)));mark('oversized_input_rejected_before_parsing');
let wasRead=false;const mock=n=>[{file:{name:'limite.bin',type:'application/octet-stream',size:n,arrayBuffer:async()=>{wasRead=true;throw new Error('unexpected read');}},kind:'file'}];
let low=0,high=MAX_BUNDLE_BYTES;while(low<high){const middle=Math.ceil((low+high)/2);if(estimateBundleSize(mock(middle))<=MAX_BUNDLE_BYTES)low=middle;else high=middle-1;}
assert.equal(estimateBundleSize(mock(low)),MAX_BUNDLE_BYTES);
await assert.rejects(()=>createBundle(mock(low+1)),/supera20/);assert.equal(wasRead,false);mark('overhead_included_and_oversize_rejected_before_file_read');
const boundary=await createBundle([{file:new File([new Uint8Array(low)],'limite.bin',{type:'application/octet-stream'}),kind:'file'}]);assert.equal(boundary.size,MAX_BUNDLE_BYTES);const boundaryResult=await readBundle(await boundary.arrayBuffer());assert.equal(boundaryResult[0].bytes.length,low);assert(boundaryResult[0].bytes.every(x=>x===0));mark('exact_20_mib_archive_boundary_roundtrip');
const report={status:'PASS',check_count:checks.length,checks,mixed_zip_bytes:file.size,maximum_archive_bytes:boundary.size,maximum_test_file_bytes:low,node:process.version,seconds:Number(((performance.now()-started)/1000).toFixed(3))};
await writeFile(new URL('./BUNDLE_REPORT.json',import.meta.url),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify(report,null,2));
