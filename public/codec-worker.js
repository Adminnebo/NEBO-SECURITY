/* ASTRA-MSG-V1 portable codec. All payload processing stays in this worker.
 * Compatible with ASTRA_MENSAJERIA/payload.py and engine/CODEC_SPEC.md.
 * Artwork pixels are permutations of preview RGB + exact file bytes + zero padding.
 */
const MAX_FILE = 20 * 1024 * 1024, MAX_PIXELS = 12000000, MAX_PREVIEW = 2000000;
const MAX_TOKEN = 48 * 1024 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder();
const B85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
const FIXED = {format:"ASTRA-PXART-V1",algorithm:"RGB-STABLE-RANK-DELTA-V1",channels:"RGB",
  indexing:"row-major:y*width+x",color_order:"unsigned-24bit:(R<<16)|(G<<8)|B;ties=flat-index-ascending",
  canonical_png:"RGB8-FILTER0-STORED-DEFLATE65535-V1",rank_encoding:"signed-delta-zigzag-uleb128;previous=0",
  compression:"zlib",payload_encoding:"RFC1924-base85"};
const fail = message => { throw new Error(message); };
const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
const equal = (a,b) => a.length === b.length && a.every((v,i)=>v===b[i]);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const hexhash = s => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

export function canonicalJSON(value) {
  const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])) : v;
  return JSON.stringify(sorted(value)).replace(/[\u007f-\uffff]/g,c=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0"));
}
export async function sha256(data) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256",bytes(data)));
  return Array.from(hash,b=>b.toString(16).padStart(2,"0")).join("");
}
async function checksum(object) {const copy={...object};delete copy.checksum_sha256;return sha256(enc.encode(canonicalJSON(copy)));}
async function seal(object) { object.checksum_sha256=await checksum(object);return object; }
function filename(name) {return Array.from(String(name||"archivo.bin").split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g,"_").replace(/^[ .]+|[ .]+$/g,"")).slice(0,160).join("")||"archivo.bin";}
function parseStrictJSON(text){
  const object=JSON.parse(text),stack=[];
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){const start=i++;for(;i<text.length;i++){if(text[i]==="\\")i++;else if(text[i]==='"')break;}const top=stack[stack.length-1];if(top&&top.keys&&top.expectKey){const key=JSON.parse(text.slice(start,i+1));if(top.keys.has(key))fail("El token contiene claves JSON duplicadas.");top.keys.add(key);top.expectKey=false;}}
    else if(c==="{")stack.push({keys:new Set(),expectKey:true});else if(c==="[")stack.push({});else if(c==="}"||c==="]")stack.pop();else if(c===","){const top=stack[stack.length-1];if(top&&top.keys)top.expectKey=true;}}
  return object;
}
function notify(cb,stage,percent) {cb({stage,percent,progress:percent,message:stage});}

const CRC_TABLE = new Uint32Array(256);
for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;CRC_TABLE[i]=c>>>0;}
function crc32(data,start=0,end=data.length){let c=0xffffffff;for(let i=start;i<end;i++)c=CRC_TABLE[(c^data[i])&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function adler32(data){let a=1,b=0;for(let p=0;p<data.length;){const end=Math.min(p+5552,data.length);for(;p<end;p++){a+=data[p];b+=a;}a%=65521;b%=65521;}return ((b<<16)|a)>>>0;}
function putChunk(output,offset,type,data){const v=new DataView(output.buffer);v.setUint32(offset,data.length);for(let i=0;i<4;i++)output[offset+4+i]=type.charCodeAt(i);output.set(data,offset+8);v.setUint32(offset+8+data.length,crc32(output,offset+4,offset+8+data.length));return offset+12+data.length;}
export function canonicalPNG(rgb,width,height){
  rgb=bytes(rgb);if(!integer(width)||!integer(height)||width<1||height<1||width*height>MAX_PIXELS||rgb.length!==width*height*3)fail("Matriz RGB invalida.");
  const stride=width*3+1,raw=new Uint8Array(stride*height);
  for(let y=0;y<height;y++)raw.set(rgb.subarray(y*width*3,(y+1)*width*3),y*stride+1);
  const blocks=Math.ceil(raw.length/65535),z=new Uint8Array(2+raw.length+blocks*5+4),zv=new DataView(z.buffer);
  z[0]=0x78;z[1]=1;let p=2;
  for(let s=0;s<raw.length;s+=65535){const n=Math.min(65535,raw.length-s);z[p++]=(s+n===raw.length)?1:0;zv.setUint16(p,n,true);zv.setUint16(p+2,n^65535,true);p+=4;z.set(raw.subarray(s,s+n),p);p+=n;}
  zv.setUint32(p,adler32(raw));
  const ihdr=new Uint8Array(13),hv=new DataView(ihdr.buffer);hv.setUint32(0,width);hv.setUint32(4,height);ihdr[8]=8;ihdr[9]=2;
  const output=new Uint8Array(8+25+12+z.length+12);output.set([137,80,78,71,13,10,26,10]);
  let offset=putChunk(output,8,"IHDR",ihdr);offset=putChunk(output,offset,"IDAT",z);putChunk(output,offset,"IEND",new Uint8Array());return output;
}
async function streamTransform(input,compress,limit){
  if(typeof CompressionStream==="undefined"||typeof DecompressionStream==="undefined")fail("Este navegador necesita CompressionStream y DecompressionStream. Use un navegador actualizado.");
  const transform=compress?new CompressionStream("deflate"):new DecompressionStream("deflate");
  const reader=new Blob([input]).stream().pipeThrough(transform).getReader();let total=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();fail("Los datos expandidos superan el limite permitido.");}chunks.push(value);}}
  catch(e){throw new Error("Compresion de datos invalida: "+e.message);}
  const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
export async function parsePNG(input,width,height){
  const data=bytes(input);if(data.length<57||data.length>MAX_PIXELS*3+100000||!equal(data.subarray(0,8),new Uint8Array([137,80,78,71,13,10,26,10])))fail("Obra PNG invalida.");
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);let offset=8,index=0,idat;
  for(const expected of ["IHDR","IDAT","IEND"]){if(offset+12>data.length)fail("PNG truncado.");const n=view.getUint32(offset),end=offset+12+n;if(end>data.length)fail("Longitud PNG invalida.");const type=String.fromCharCode(...data.subarray(offset+4,offset+8));if(type!==expected||crc32(data,offset+4,offset+8+n)!==view.getUint32(offset+8+n))fail("Estructura o CRC del PNG incorrectos.");
    if(index===0){if(n!==13||view.getUint32(offset+8)!==width||view.getUint32(offset+12)!==height||!equal(data.subarray(offset+16,offset+21),new Uint8Array([8,2,0,0,0])))fail("Dimensiones o perfil RGB del PNG incompatibles.");}
    if(index===1)idat=data.subarray(offset+8,offset+8+n);if(index===2&&n!==0)fail("IEND invalido.");offset=end;index++;}
  if(offset!==data.length)fail("Datos adicionales despues del PNG.");
  const expected=(width*3+1)*height,raw=await streamTransform(idat,false,expected);if(raw.length!==expected)fail("Longitud de pixeles incorrecta.");
  const rgb=new Uint8Array(width*height*3),stride=width*3+1;for(let y=0;y<height;y++){if(raw[y*stride]!==0)fail("La obra debe usar el filtro PNG 0.");rgb.set(raw.subarray(y*stride+1,(y+1)*stride),y*width*3);}return rgb;
}
export function base85Encode(data){
  const output=new Uint8Array(Math.ceil(data.length*5/4));let p=0;
  for(let i=0;i<data.length;i+=4){const n=Math.min(4,data.length-i);let value=0;for(let j=0;j<4;j++)value=value*256+(j<n?data[i+j]:0);const group=new Uint8Array(5);for(let j=4;j>=0;j--){group[j]=B85.charCodeAt(value%85);value=Math.floor(value/85);}output.set(group.subarray(0,n+1),p);p+=n+1;}return dec.decode(output);
}
export function base85Decode(text){
  if(typeof text!=="string"||text.length%5===1)fail("Payload Base85 invalido.");const map=new Int16Array(128).fill(-1);for(let i=0;i<85;i++)map[B85.charCodeAt(i)]=i;
  const output=new Uint8Array(Math.floor(text.length/5)*4+(text.length%5?text.length%5-1:0));let p=0;
  for(let i=0;i<text.length;i+=5){const n=Math.min(5,text.length-i);let value=0;for(let j=0;j<5;j++){const code=j<n?text.charCodeAt(i+j):126;if(code>=128||map[code]<0)fail("Caracter Base85 invalido.");value=value*85+map[code];}if(value>4294967295)fail("Desbordamiento Base85.");const group=new Uint8Array(4);for(let j=3;j>=0;j--){group[j]=value%256;value=Math.floor(value/256);}output.set(group.subarray(0,n-1),p);p+=n-1;}
  if(base85Encode(output)!==text)fail("Payload Base85 no canonico.");return output;
}
function pack(rgb){const result=new Uint32Array(rgb.length/3);for(let i=0,j=0;i<result.length;i++,j+=3)result[i]=(rgb[j]<<16)|(rgb[j+1]<<8)|rgb[j+2];return result;}
function rgbRanks(rgb){
  const count=rgb.length/3;let order=new Uint32Array(count),temp=new Uint32Array(count);for(let i=0;i<count;i++)order[i]=i;
  for(let channel=2;channel>=0;channel--){const starts=new Uint32Array(256);for(let i=channel;i<rgb.length;i+=3)starts[rgb[i]]++;let total=0;for(let k=0;k<256;k++){const n=starts[k];starts[k]=total;total+=n;}for(let i=0;i<count;i++){const original=order[i];temp[starts[rgb[original*3+channel]]++]=original;}[order,temp]=[temp,order];}
  const ranks=temp;for(let k=0;k<count;k++)ranks[order[k]]=k;return ranks;
}
function encodeRanks(ranks){let size=0,prev=0;for(const rank of ranks){const d=rank-prev;prev=rank;let u=d>=0?2*d:-2*d-1;do{size++;u=Math.floor(u/128);}while(u);}const output=new Uint8Array(size);let p=0;prev=0;for(const rank of ranks){const d=rank-prev;prev=rank;let u=d>=0?2*d:-2*d-1;while(u>=128){output[p++]=(u%128)|128;u=Math.floor(u/128);}output[p++]=u;}return output;}
function decodeRanks(raw,count){const ranks=new Uint32Array(count),seen=new Uint8Array(count);let pos=0,prev=0,u=0,shift=0;for(const byte of raw){if(pos>=count)fail("Rangos adicionales en token.");u+=(byte&127)*2**shift;if(byte&128){shift+=7;if(shift>28)fail("Rango demasiado grande.");continue;}if(shift&&byte===0)fail("Varint no canonico.");const d=u%2===0?u/2:-(u+1)/2,rank=prev+d;if(!integer(rank)||rank>=count||seen[rank])fail("La permutacion no es biyectiva.");seen[rank]=1;ranks[pos++]=rank;prev=rank;u=shift=0;}if(shift||pos!==count)fail("Token de rangos truncado.");return ranks;}
function rgbaToRGB(image,limit){
  if(!image||!integer(image.width)||!integer(image.height)||image.width<1||image.height<1||image.width*image.height>limit)fail("Dimensiones de imagen invalidas.");const input=bytes(image.data),pixels=image.width*image.height,channels=image.channels||(input.length===pixels*4?4:3);if(![3,4].includes(channels)||input.length!==pixels*channels)fail("Canales de imagen invalidos.");if(channels===3)return input;const rgb=new Uint8Array(pixels*3);for(let i=0;i<pixels;i++){rgb[3*i]=input[4*i];rgb[3*i+1]=input[4*i+1];rgb[3*i+2]=input[4*i+2];}return rgb;
}
function bayer32(){let a=new Uint16Array([0]),size=1;while(size<32){const next=new Uint16Array(size*size*4),n=size*2;for(let y=0;y<size;y++)for(let x=0;x<size;x++){const v=a[y*size+x]*4;next[y*n+x]=v;next[y*n+x+size]=v+2;next[(y+size)*n+x]=v+3;next[(y+size)*n+x+size]=v+1;}a=next;size=n;}return a;}
function assignArtwork(source,width,height,target){
  const count=width*height,luma=new Uint16Array(count),sourceOrder=new Uint32Array(count),buckets=new Uint32Array(256);
  for(let i=0;i<count;i++){const y=(77*source[i*3]+150*source[i*3+1]+29*source[i*3+2])>>>8;luma[i]=y;buckets[y]++;}let sum=0;for(let j=0;j<256;j++){const n=buckets[j];buckets[j]=sum;sum+=n;}for(let i=0;i<count;i++)sourceOrder[buckets[luma[i]]++]=i;
  if(target){const targetRGB=rgbaToRGB(target,MAX_PIXELS);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const tx=Math.min(target.width-1,Math.floor(x*target.width/width)),ty=Math.min(target.height-1,Math.floor(y*target.height/height)),i=(ty*target.width+tx)*3;luma[y*width+x]=(77*targetRGB[i]+150*targetRGB[i+1]+29*targetRGB[i+2])>>>8;}}
  else{ // Procedural mountain guide affects placement only; it contributes no payload pixels.
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const nx=Math.floor(x*1000/width),peak=Math.max(0,1000-Math.abs(nx-440)*3),ridge=Math.floor(height*55/100)-Math.floor(height*22*peak/100000)+Math.floor(height*((nx%120)-60)/2000);luma[y*width+x]=y<ridge?175+Math.floor(65*y/height):25+Math.floor(90*(height-y)/height);}}
  const scores=new Float64Array(count),dest=new Uint32Array(count),screen=bayer32();for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x,d=255-luma[i],edge=Math.min(Math.abs(luma[i]-luma[y*width+Math.max(x-1,0)])+Math.abs(luma[i]-luma[Math.max(y-1,0)*width+x]),48),density=Math.floor((d+8)**3*(256+edge)/256)+1;scores[i]=Math.floor((2*screen[(y%32)*32+x%32]+1)*4294967296/density);dest[i]=i;}
  dest.sort((a,b)=>scores[a]-scores[b]||a-b);const art=new Uint8Array(source.length);for(let k=0;k<count;k++){const from=sourceOrder[k]*3,to=dest[k]*3;art[to]=source[from];art[to+1]=source[from+1];art[to+2]=source[from+2];}return art;
}
function validateEnvelope(t){
  const expected=["format","filename","mime_type","kind","render_scope","source_sha256","file_bytes","payload_byte_offset","padding_bytes","preview","engine_token","checksum_sha256"].sort();if(!t||typeof t!=="object"||Object.keys(t).sort().join("|")!==expected.join("|")||t.format!=="ASTRA-MSG-V1")fail("Formato de token incompatible.");
  for(const key of ["file_bytes","payload_byte_offset","padding_bytes"])if(!integer(t[key]))fail("Limites de archivo invalidos.");if(t.file_bytes<1||t.file_bytes>MAX_FILE)fail("El archivo supera20 MiB.");if(typeof t.filename!=="string"||filename(t.filename)!==t.filename||typeof t.mime_type!=="string"||t.mime_type.length>120||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+(?:; charset=utf-8)?$/.test(t.mime_type)||!["image","audio","pdf","text"].includes(t.kind)||typeof t.render_scope!=="string"||t.render_scope.length>500||!hexhash(t.source_sha256)||!hexhash(t.checksum_sha256))fail("Metadatos de archivo invalidos.");
  const e=t.engine_token;if(!e||typeof e!=="object")fail("Token de motor ausente.");for(const[k,v]of Object.entries(FIXED))if(e[k]!==v)fail("Algoritmo de reconstruccion incompatible.");
  const fields=[...Object.keys(FIXED),"width","height","pixel_count","original_file_bytes","artwork_file_bytes","original_file_sha256","artwork_file_sha256","original_pixels_sha256","artwork_pixels_sha256","rank_varint_bytes","compressed_payload_bytes","payload_sha256","payload_data","checksum_sha256"].sort();if(Object.keys(e).sort().join("|")!==fields.join("|"))fail("Esquema de motor invalido.");
  for(const key of ["width","height","pixel_count","original_file_bytes","artwork_file_bytes","rank_varint_bytes","compressed_payload_bytes"])if(!integer(e[key])||e[key]<1)fail("Dimensiones del motor invalidas.");const count=e.width*e.height;if(count!==e.pixel_count||count>MAX_PIXELS||count*3!==t.payload_byte_offset+t.file_bytes+t.padding_bytes)fail("La matriz supera los limites o no coincide.");if(e.rank_varint_bytes<count||e.rank_varint_bytes>count*5||typeof e.payload_data!=="string")fail("Longitud de rangos invalida.");for(const key of ["original_file_sha256","artwork_file_sha256","original_pixels_sha256","artwork_pixels_sha256","payload_sha256","checksum_sha256"])if(!hexhash(e[key]))fail("Hash invalido.");
  if(t.preview===null){if(t.payload_byte_offset!==0)fail("Vista ausente con desplazamiento invalido.");}else{const p=t.preview;if(!p||Object.keys(p).sort().join("|")!=="height|rgb_sha256|width"||!integer(p.width)||!integer(p.height)||p.width<1||p.height<1||p.width*p.height>MAX_PREVIEW||p.width*p.height*3!==t.payload_byte_offset||!hexhash(p.rgb_sha256))fail("Vista previa invalida.");}
}

export async function decodeMessage(input,progress=()=>{}){
  notify(progress,"Verificando token",5);const artwork=bytes(input.artwork),tokenBytes=typeof input.token==="string"?enc.encode(input.token):bytes(input.token);if(!tokenBytes.length||tokenBytes.length>MAX_TOKEN||artwork.length>MAX_PIXELS*3+100000)fail("Tamano de token u obra invalido.");for(const value of tokenBytes)if(value>127)fail("El token debe usar JSON ASCII.");
  let token;try{token=parseStrictJSON(dec.decode(tokenBytes));}catch(error){fail("El token no es JSON valido: "+error.message);}validateEnvelope(token);const e=token.engine_token;if(await checksum(token)!==token.checksum_sha256||await checksum(e)!==e.checksum_sha256)fail("El token fue modificado: checksum incorrecto.");
  if(artwork.length!==e.artwork_file_bytes||await sha256(artwork)!==e.artwork_file_sha256)fail("La obra no coincide con el token.");const compressed=base85Decode(e.payload_data);if(compressed.length!==e.compressed_payload_bytes||await sha256(compressed)!==e.payload_sha256)fail("Payload de rangos alterado.");
  notify(progress,"Restaurando coordenadas",25);const raw=await streamTransform(compressed,false,e.rank_varint_bytes);if(raw.length!==e.rank_varint_bytes)fail("Longitud de rangos incorrecta.");const ranks=decodeRanks(raw,e.pixel_count);
  notify(progress,"Leyendo los pixeles originales de la obra",45);const artworkRGB=await parsePNG(artwork,e.width,e.height);if(await sha256(artworkRGB)!==e.artwork_pixels_sha256)fail("Hash de pixeles de obra incorrecto.");const values=pack(artworkRGB);values.sort();const rgb=new Uint8Array(e.pixel_count*3);for(let i=0;i<ranks.length;i++){const c=values[ranks[i]];rgb[3*i]=(c>>>16)&255;rgb[3*i+1]=(c>>>8)&255;rgb[3*i+2]=c&255;}
  notify(progress,"Verificando la reconstruccion exacta",75);if(await sha256(rgb)!==e.original_pixels_sha256)fail("Los pixeles reconstruidos no coinciden.");const png=canonicalPNG(rgb,e.width,e.height);if(png.length!==e.original_file_bytes||await sha256(png)!==e.original_file_sha256)fail("El PNG reconstruido no coincide byte por byte.");
  const start=token.payload_byte_offset,end=start+token.file_bytes,file=rgb.slice(start,end);for(let i=end;i<rgb.length;i++)if(rgb[i]!==0)fail("Relleno alterado.");const hash=await sha256(file);if(hash!==token.source_sha256)fail("El archivo reconstruido no coincide con SHA-256.");if(token.preview&&await sha256(rgb.subarray(0,start))!==token.preview.rgb_sha256)fail("La vista previa no coincide.");notify(progress,"Archivo reconstruido y verificado",100);
  return {file:file.buffer,name:token.filename,filename:token.filename,mime:token.mime_type,mime_type:token.mime_type,sha256:hash,source_sha256:hash,recovered_sha256:hash,exact_file_recovery:true,file_bytes:file.length,kind:token.kind,render_scope:token.render_scope,width:e.width,height:e.height,pixel_count:e.pixel_count};
}

export async function encodeMessage(input,progress=()=>{}){
  const file=bytes(input.file);if(!file.length||file.length>MAX_FILE)fail("El archivo debe tener entre1 byte y20 MiB.");const name=filename(input.name),mime=String(input.mime||"application/octet-stream").toLowerCase();if(!/^[-a-z0-9.+]+\/[-a-z0-9.+]+(?:; charset=utf-8)?$/.test(mime))fail("Tipo de archivo invalido.");
  notify(progress,"Preparando los bytes originales",5);const preview=input.preview?rgbaToRGB(input.preview,MAX_PREVIEW):new Uint8Array(),needed=Math.ceil((preview.length+file.length)/3),width=Math.max(1,Math.ceil(Math.sqrt(needed*8.5/11))),height=Math.ceil(needed/width),count=width*height;if(count>MAX_PIXELS)fail("La matriz supera12 millones de pixeles.");const source=new Uint8Array(count*3);source.set(preview);source.set(file,preview.length);
  notify(progress,"Reordenando los pixeles en el paisaje",20);const art=assignArtwork(source,width,height,input.target);
  notify(progress,"Construyendo la clave de coordenadas",45);const ranks=rgbRanks(source),raw=encodeRanks(ranks),compressed=await streamTransform(raw,true,MAX_TOKEN),sourcePNG=canonicalPNG(source,width,height),artwork=canonicalPNG(art,width,height);
  // Exact histogram verification, separate from assignment logic.
  const sv=pack(source),av=pack(art);sv.sort();av.sort();if(!equal(sv,av))fail("La obra no conserva el multiconjunto RGB.");let mismatches=0;for(let i=0;i<count;i++){const c=av[ranks[i]],j=i*3;if(source[j]!==((c>>>16)&255)||source[j+1]!==((c>>>8)&255)||source[j+2]!==(c&255))mismatches++;}if(mismatches)fail("Fallo de reconstruccion de pixeles.");
  const engine={...FIXED,width,height,pixel_count:count,original_file_bytes:sourcePNG.length,artwork_file_bytes:artwork.length,original_file_sha256:await sha256(sourcePNG),artwork_file_sha256:await sha256(artwork),original_pixels_sha256:await sha256(source),artwork_pixels_sha256:await sha256(art),rank_varint_bytes:raw.length,compressed_payload_bytes:compressed.length,payload_sha256:await sha256(compressed),payload_data:base85Encode(compressed)};await seal(engine);
  const kind=mime.startsWith("audio/")?"audio":mime==="application/pdf"?"pdf":mime.startsWith("image/")?"image":"text",scope=preview.length?(kind==="pdf"?"Vista de la primera pagina + archivo PDF completo":"Vista RGB + archivo original completo"):(kind==="audio"?"Audio completo: sus bytes forman los pixeles de la obra":"Archivo completo: sus bytes forman los pixeles de la obra"),sourceHash=await sha256(file);
  const token={format:"ASTRA-MSG-V1",filename:name,mime_type:mime,kind,render_scope:scope,source_sha256:sourceHash,file_bytes:file.length,payload_byte_offset:preview.length,padding_bytes:source.length-preview.length-file.length,preview:preview.length?{width:input.preview.width,height:input.preview.height,rgb_sha256:await sha256(preview)}:null,engine_token:engine};await seal(token);const tokenBytes=enc.encode(canonicalJSON(token)+"\n");if(tokenBytes.length>MAX_TOKEN)fail("El token supera48 MiB.");
  notify(progress,"Comprobando la recuperacion con solo obra y token",85);const recovered=await decodeMessage({artwork,token:tokenBytes},()=>{});if(!equal(new Uint8Array(recovered.file),file))fail("El archivo no se recupero exactamente.");notify(progress,"Obra y token verificados",100);
  return {artwork:artwork.buffer,token:tokenBytes.buffer,name,filename:name,mime,mime_type:mime,source_sha256:sourceHash,recovered_sha256:recovered.sha256,sha256:sourceHash,exact_file_recovery:true,mismatch_count:0,histogram_verified:true,width,height,pixel_count:count,file_bytes:file.length,input_bytes:file.length,token_bytes:tokenBytes.length,artwork_bytes:artwork.length,kind,render_scope:scope,preview_available:!!preview.length};
}

if(typeof self!=="undefined"&&typeof self.postMessage==="function"&&typeof document==="undefined"){
  self.onmessage=async({data})=>{const {id,action}=data;try{const report=p=>self.postMessage({id,type:"progress",...p});const result=action==="encode"?await encodeMessage(data,report):action==="decode"?await decodeMessage(data,report):fail("Accion desconocida.");const transfer=action==="encode"?[result.artwork,result.token]:[result.file];self.postMessage({id,type:"result",action,...result},transfer);}catch(error){self.postMessage({id,type:"error",error:error.message,message:error.message});}};
  self.postMessage({type:"ready"});
}
