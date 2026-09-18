import assert from "node:assert/strict";
import {encodeMessage,decodeMessage,base85Encode,base85Decode,canonicalJSON,canonicalPNG,parsePNG} from "../public/codec-worker.js";

const checks=[];
for(const length of [0,1,2,3,4,5,7,8,255,256,257,4096]){
  const original=Uint8Array.from({length},(_,i)=>(i*137+length)%256);
  assert.deepEqual(base85Decode(base85Encode(original)),original);
}
checks.push("base85_lengths_and_boundaries");
assert.equal(canonicalJSON({z:"🌄",a:"café\u007f"}),'{'+'"a":"caf\\u00e9\\u007f","z":"\\ud83c\\udf04"}');
checks.push("python_ensure_ascii_unicode_and_surrogates");
for(const [width,height] of [[1,1],[170,129]]){
  const rgb=Uint8Array.from({length:width*height*3},(_,i)=>(i*17)%256);
  const png=canonicalPNG(rgb,width,height);
  assert.deepEqual(await parsePNG(png,width,height),rgb);
  assert.deepEqual(canonicalPNG(rgb,width,height),png);
}
checks.push("canonical_png_roundtrip_and_deflate_block_boundary");
const original=Uint8Array.from({length:6001},(_,i)=>(i*71)%256);
const input={file:original.buffer,name:"paisaje-á-🌄.bin",mime:"application/octet-stream"};
const first=await encodeMessage(input),second=await encodeMessage(input);
assert.deepEqual(new Uint8Array(first.artwork),new Uint8Array(second.artwork));
assert.deepEqual(new Uint8Array(first.token),new Uint8Array(second.token));
checks.push("repeated_encoding_identical_artwork_and_token");
const restored=await decodeMessage(first);
assert.deepEqual(new Uint8Array(restored.file),original);
checks.push("file_byte_exact_roundtrip");
const duplicate=new TextDecoder().decode(first.token).replace('{','{"format":"ASTRA-MSG-V1",');
await assert.rejects(()=>decodeMessage({artwork:first.artwork,token:duplicate}),/duplicadas/);
checks.push("duplicate_json_key_rejected");
const corrupt=new Uint8Array(first.artwork.slice(0));corrupt[100]^=1;
await assert.rejects(()=>decodeMessage({artwork:corrupt,token:first.token}),/no coincide/);
checks.push("changed_artwork_rejected");
console.log(JSON.stringify({status:"PASS",checks,token_bytes:first.token_bytes,pixel_count:first.pixel_count},null,2));
