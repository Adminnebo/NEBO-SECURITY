/* NEBO-BUNDLE-V1: deterministic, bounded ZIP STORE attachments.
 * No network, compression, external dependencies, or disk extraction.
 * This is a plaintext container; secure-worker encrypts the complete ZIP.
 */
export const MAX_BUNDLE_BYTES=20*1024*1024;
export const MAX_BUNDLE_ITEMS=32;
export const BUNDLE_MIME="application/vnd.nebo.bundle+zip";
const FORMAT="NEBO-BUNDLE-V1",MANIFEST="manifest.json",MAX_MANIFEST=128*1024;
const encoder=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true});
const KINDS=new Set(["file","text","voice","location"]),FLAGS=0x0800,VERSION=20,DOS_DATE=0x0021;
const fail=message=>{throw new Error(message);};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const exactKeys=(object,keys)=>object&&typeof object==="object"&&!Array.isArray(object)&&Object.keys(object).sort().join("|")===keys.slice().sort().join("|");
function canonical(value){const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;return JSON.stringify(sort(value));}
function jsonBytes(value){return encoder.encode(canonical(value));}
function safeName(value,index){let name=decoder.decode(encoder.encode(String(value||""))).normalize("NFC").split(/[\\/]/).pop();name=name.replace(/[\x00-\x1f\x7f-\x9f<>:"|?*\u200b\u202a-\u202e\u2066-\u2069\ufeff]/g,"_").replace(/^[ .]+|[ .]+$/g,"");name=Array.from(name).slice(0,160).join("").replace(/[ .]+$/g,"");if(!name)name=`archivo-${String(index+1).padStart(4,"0")}.bin`;if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name="_"+Array.from(name).slice(0,159).join("");return name;}
function mimeType(value){const mime=String(value||"").split(";")[0].trim().toLowerCase();return mime.length<=200&&/^[-a-z0-9!#$&^_.+]+\/[-a-z0-9!#$&^_.+]+$/.test(mime)?mime:"application/octet-stream";}
function pathFor(name,index){return `files/${String(index+1).padStart(4,"0")}-${name}`;}
function prepare(items){if(!Array.isArray(items)||items.length<1||items.length>MAX_BUNDLE_ITEMS)fail("Un envio admite entre1 y32 adjuntos.");return items.map((item,index)=>{if(!item||!KINDS.has(item.kind)||!item.file||typeof item.file.arrayBuffer!=="function"||!integer(item.file.size)||item.file.size>0xffffffff)fail("Adjunto o tipo de adjunto invalido.");const name=safeName(item.file.name,index),mime=mimeType(item.file.type);return {file:item.file,info:{path:pathFor(name,index),name,mime,kind:item.kind,bytes:item.file.size,sha256:"0".repeat(64)}};});}
function manifestFor(prepared){return {format:FORMAT,version:1,items:prepared.map(entry=>entry.info)};}
function estimate(prepared){const manifest=jsonBytes(manifestFor(prepared));if(manifest.length>MAX_MANIFEST)fail("El manifiesto de adjuntos es demasiado grande.");let total=22+76+encoder.encode(MANIFEST).length*2+manifest.length;for(const entry of prepared)total+=76+encoder.encode(entry.info.path).length*2+entry.info.bytes;if(!Number.isSafeInteger(total))fail("Tamano total no representable.");return total;}
export function estimateBundleSize(items){return estimate(prepare(items));}
export function isBundleMime(mime){return typeof mime==="string"&&mime.split(";")[0].trim().toLowerCase()===BUNDLE_MIME;}

const CRC_TABLE=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;CRC_TABLE[i]=c>>>0;}
function crc32(data){let crc=0xffffffff;for(const byte of data)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
async function sha256(data){const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",data));return Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");}
function matching(a,b){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}

export async function createBundle(items){
  const prepared=prepare(items),expected=estimate(prepared);if(expected>MAX_BUNDLE_BYTES)fail(`El envio completo ocupa ${expected} bytes y supera20 MiB, incluido el contenedor.`);
  const payloads=await Promise.all(prepared.map(async entry=>{const raw=await entry.file.arrayBuffer();if(!(raw instanceof ArrayBuffer)||raw.byteLength!==entry.info.bytes)fail("El tamano de un adjunto cambio durante la lectura.");const data=new Uint8Array(raw);entry.info.sha256=await sha256(data);return {path:entry.info.path,data};}));
  const manifest=jsonBytes(manifestFor(prepared)),entries=[{path:MANIFEST,data:manifest},...payloads].map(entry=>({...entry,name:encoder.encode(entry.path),crc:crc32(entry.data)}));
  const output=new Uint8Array(expected),view=new DataView(output.buffer);let offset=0;
  for(const entry of entries){entry.offset=offset;view.setUint32(offset,0x04034b50,true);view.setUint16(offset+4,VERSION,true);view.setUint16(offset+6,FLAGS,true);view.setUint16(offset+8,0,true);view.setUint16(offset+10,0,true);view.setUint16(offset+12,DOS_DATE,true);view.setUint32(offset+14,entry.crc,true);view.setUint32(offset+18,entry.data.length,true);view.setUint32(offset+22,entry.data.length,true);view.setUint16(offset+26,entry.name.length,true);view.setUint16(offset+28,0,true);output.set(entry.name,offset+30);output.set(entry.data,offset+30+entry.name.length);offset+=30+entry.name.length+entry.data.length;}
  const centralOffset=offset;
  for(const entry of entries){view.setUint32(offset,0x02014b50,true);view.setUint16(offset+4,VERSION,true);view.setUint16(offset+6,VERSION,true);view.setUint16(offset+8,FLAGS,true);view.setUint16(offset+10,0,true);view.setUint16(offset+12,0,true);view.setUint16(offset+14,DOS_DATE,true);view.setUint32(offset+16,entry.crc,true);view.setUint32(offset+20,entry.data.length,true);view.setUint32(offset+24,entry.data.length,true);view.setUint16(offset+28,entry.name.length,true);view.setUint16(offset+30,0,true);view.setUint16(offset+32,0,true);view.setUint16(offset+34,0,true);view.setUint16(offset+36,0,true);view.setUint32(offset+38,0,true);view.setUint32(offset+42,entry.offset,true);output.set(entry.name,offset+46);offset+=46+entry.name.length;}
  const centralSize=offset-centralOffset;view.setUint32(offset,0x06054b50,true);view.setUint16(offset+4,0,true);view.setUint16(offset+6,0,true);view.setUint16(offset+8,entries.length,true);view.setUint16(offset+10,entries.length,true);view.setUint32(offset+12,centralSize,true);view.setUint32(offset+16,centralOffset,true);view.setUint16(offset+20,0,true);offset+=22;
  if(offset!==expected)fail("El calculo de tamano del ZIP no coincide.");
  return new File([output],"NEBO-envio.zip",{type:BUNDLE_MIME,lastModified:0});
}

function readUTF8(data){try{const text=decoder.decode(data);if(!matching(encoder.encode(text),data))fail("UTF-8 no canonico.");return text;}catch{fail("Texto UTF-8 invalido dentro del ZIP.");}}
function parseStrictJSON(text){let object;try{object=JSON.parse(text);}catch{fail("Manifiesto JSON invalido.");}const stack=[];for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){const start=i++;for(;i<text.length;i++){if(text[i]==="\\")i++;else if(text[i]==='"')break;}const top=stack.at(-1);if(top?.keys&&top.expect){const key=JSON.parse(text.slice(start,i+1));if(top.keys.has(key))fail("Claves JSON repetidas en el manifiesto.");top.keys.add(key);top.expect=false;}}else if(c==="{")stack.push({keys:new Set(),expect:true});else if(c==="[")stack.push({});else if(c==="}"||c==="]")stack.pop();else if(c===","&&stack.at(-1)?.keys)stack.at(-1).expect=true;}return object;}
function inputBytes(input){let view;if(input instanceof ArrayBuffer)view=new Uint8Array(input);else if(ArrayBuffer.isView(input))view=new Uint8Array(input.buffer,input.byteOffset,input.byteLength);else fail("Se esperaban bytes del contenedor ZIP.");if(view.length<22||view.length>MAX_BUNDLE_BYTES)fail("El ZIP debe caber en20 MiB.");return view.slice();}

export async function readBundle(input){
  const data=inputBytes(input),view=new DataView(data.buffer),end=data.length-22;
  if(view.getUint32(end,true)!==0x06054b50||view.getUint16(end+4,true)!==0||view.getUint16(end+6,true)!==0||view.getUint16(end+20,true)!==0)fail("Final ZIP invalido: no se admiten comentarios ni discos multiples.");
  const count=view.getUint16(end+10,true),centralSize=view.getUint32(end+12,true),centralOffset=view.getUint32(end+16,true);
  if(count<2||count>MAX_BUNDLE_ITEMS+1||view.getUint16(end+8,true)!==count||centralOffset+centralSize!==end||centralOffset>=end)fail("Directorio ZIP fuera de limites.");
  const entries=[],names=new Set();let position=centralOffset,localPosition=0;
  for(let index=0;index<count;index++){
    if(position+46>end||view.getUint32(position,true)!==0x02014b50)fail("Directorio central truncado.");
    if(view.getUint16(position+4,true)!==VERSION||view.getUint16(position+6,true)!==VERSION||view.getUint16(position+8,true)!==FLAGS||view.getUint16(position+10,true)!==0||view.getUint16(position+12,true)!==0||view.getUint16(position+14,true)!==DOS_DATE||view.getUint16(position+30,true)!==0||view.getUint16(position+32,true)!==0||view.getUint16(position+34,true)!==0||view.getUint16(position+36,true)!==0||view.getUint32(position+38,true)!==0)fail("Perfil ZIP incompatible: solo STORE UTF-8 canonico sin extras ni atributos.");
    const crc=view.getUint32(position+16,true),size=view.getUint32(position+24,true),nameLength=view.getUint16(position+28,true),localOffset=view.getUint32(position+42,true);
    if(view.getUint32(position+20,true)!==size||size>MAX_BUNDLE_BYTES||nameLength<1||nameLength>1024||position+46+nameLength>end||localOffset!==localPosition)fail("Tamano, nombre o posicion ZIP invalidos.");
    const nameBytes=data.subarray(position+46,position+46+nameLength),name=readUTF8(nameBytes);if(names.has(name))fail("Nombres de entrada ZIP duplicados.");names.add(name);
    if(localOffset+30>centralOffset||view.getUint32(localOffset,true)!==0x04034b50||view.getUint16(localOffset+4,true)!==VERSION||view.getUint16(localOffset+6,true)!==FLAGS||view.getUint16(localOffset+8,true)!==0||view.getUint16(localOffset+10,true)!==0||view.getUint16(localOffset+12,true)!==DOS_DATE||view.getUint32(localOffset+14,true)!==crc||view.getUint32(localOffset+18,true)!==size||view.getUint32(localOffset+22,true)!==size||view.getUint16(localOffset+26,true)!==nameLength||view.getUint16(localOffset+28,true)!==0)fail("Cabecera local ZIP incompatible con su directorio.");
    const start=localOffset+30+nameLength,finish=start+size;if(finish>centralOffset||!matching(data.subarray(localOffset+30,start),nameBytes))fail("Rangos o nombres ZIP solapados o inconsistentes.");
    const content=data.subarray(start,finish);if(crc32(content)!==crc)fail("CRC-32 incorrecto: un adjunto fue modificado.");entries.push({name,data:content,size});localPosition=finish;position+=46+nameLength;
  }
  if(position!==end||localPosition!==centralOffset)fail("El ZIP contiene huecos, datos ocultos o entradas adicionales.");
  if(entries[0].name!==MANIFEST||entries[0].size>MAX_MANIFEST)fail("Manifiesto ausente o demasiado grande.");
  const manifest=parseStrictJSON(readUTF8(entries[0].data));if(!exactKeys(manifest,["format","version","items"])||manifest.format!==FORMAT||manifest.version!==1||!Array.isArray(manifest.items)||manifest.items.length!==count-1||manifest.items.length<1||manifest.items.length>MAX_BUNDLE_ITEMS)fail("Formato del manifiesto incompatible.");
  if(!matching(jsonBytes(manifest),entries[0].data))fail("El manifiesto debe usar JSON canonico UTF-8.");
  const results=[];
  for(let index=0;index<manifest.items.length;index++){
    const metadata=manifest.items[index],entry=entries[index+1];if(!exactKeys(metadata,["path","name","mime","kind","bytes","sha256"])||typeof metadata.name!=="string"||safeName(metadata.name,index)!==metadata.name||metadata.path!==pathFor(metadata.name,index)||entry.name!==metadata.path||typeof metadata.mime!=="string"||mimeType(metadata.mime)!==metadata.mime||!KINDS.has(metadata.kind)||!integer(metadata.bytes)||metadata.bytes!==entry.size||typeof metadata.sha256!=="string"||!/^[0-9a-f]{64}$/.test(metadata.sha256))fail("Nombre, ruta, tipo o longitud de adjunto invalidos.");
    const digest=await sha256(entry.data);if(digest!==metadata.sha256)fail("SHA-256 incorrecto: el adjunto no coincide con el manifiesto.");
    results.push({name:metadata.name,mime:metadata.mime,kind:metadata.kind,bytes:entry.data.slice(),sha256:digest});
  }
  return results;
}
