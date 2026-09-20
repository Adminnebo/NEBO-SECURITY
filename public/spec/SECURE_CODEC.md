# ASTRA-SECURE-V2: portador visual cifrado

Este modo nuevo utiliza una imagen elegida por el usuario como portador de
datos cifrados. **No es la permutación de píxeles del documento de ASTRA-MSG-V1.**
El contenido original completo se cifra y se guarda en los bits menos
significativos de los canales RGB del portador. La imagen mantiene sus colores
y composición; se mide la diferencia real introducida.

El receptor necesita el PNG, el token cifrado y una autorización criptográfica:
la clave privada de recuperación, o su identidad local de destinatario.
El token no incluye la clave necesaria para descifrarse.
El token puede viajar integrado en un chunk privado `neBo` del propio PNG;
en ese caso el receptor selecciona solamente la imagen y su clave o identidad.
El envoltorio se especifica en `PORTABLE_PNG.md` y no cambia la criptografía V2.

## Seis protecciones implementadas

1. **Material de clave de alta entropía:** 32 bytes aleatorios por defecto en
   modo secreto, o ECDH P-256 con una clave efímera nueva para el destinatario.
2. **Separación de claves:** HKDF-SHA256 con sal aleatoria de 32 bytes deriva
   claves AES independientes para el archivo y para el token.
3. **Cifrado autenticado del archivo:** AES-256-GCM, IV aleatorio de 12 bytes,
   etiqueta de autenticación de 128 bits y cabecera completa como AAD.
4. **Cifrado autenticado del token:** otra clave AES-256-GCM y otro IV aleatorio
   protegen los parámetros de extracción y el hash del PNG.
5. **Integridad de la obra base:** el hash SHA-256 del PNG base completo está
   dentro del token autenticado. Se detectan cambios incluso en píxeles sin
   carga útil. Si existe un chunk `neBo`, se elimina solo ese chunk para obtener
   el PNG base; el token que contenía se autentica mediante AES-GCM.
6. **Validación e identidad:** esquemas y tamaños estrictos, huellas verificadas
   para claves públicas, claves privadas locales no exportables y una
   reconstrucción completa de prueba antes de entregar cada resultado.

Todas las operaciones criptográficas usan Web Crypto nativo. No se implementan
algoritmos de cifrado, generadores aleatorios ni curvas elípticas propios.
CRC-32 y Adler-32 se usan únicamente para el formato PNG, no como protección
criptográfica.

## Formato del archivo cifrado

La trama antes del cifrado es:

```text
longitud_metadatos: uint32 big-endian
metadatos: JSON {name, mime, sha256}
archivo_original: bytes exactos
```

Los metadatos se serializan como JSON compacto con claves ordenadas y escapes
ASCII; `sha256` es el hash hexadecimal del archivo original. El nombre, MIME,
hash original y bytes originales permanecen dentro del cifrado. El tamaño de
los metadatos está limitado a 8192 bytes y el archivo a 20 MiB.

La salida AES-GCM es `ciphertext || tag_de_16_bytes`. No se añaden copias del
original a metadatos PNG, archivos auxiliares ni campos públicos del token.
El nombre y hash pueden mostrarse al propio emisor/receptor después de una
operación válida, sin quedar expuestos en el token de transporte.

## Cabecera y token

El JSON transportable tiene campos públicos:

```text
format = "ASTRA-SECURE-V2"
version = 2
mode = "secret" | "recipient"
kdf = "HKDF-SHA256"
cipher = "AES-256-GCM"
salt = base64url de 32 bytes
payload_iv = base64url de 12 bytes
token_iv = base64url de 12 bytes
encrypted_body = base64url del cuerpo cifrado y su etiqueta GCM
```

En modo `recipient` incluye además `recipient_fingerprint` y
`ephemeral_public`, la clave pública efímera JWK mínima `{crv,kty,x,y}`.
El modo secreto no admite esos campos. Se rechazan campos desconocidos,
claves JSON repetidas, versiones diferentes, IV iguales, codificaciones
base64url no canónicas y tamaños fuera de los límites.

La AAD para **ambos** cifrados es el JSON de todos los campos públicos,
excluyendo únicamente `encrypted_body`. Se ordenan las claves y se eliminan
espacios; los caracteres UTF-16 desde U+007F se escapan como `\uXXXX` en
minúsculas. Esta AAD vincula la versión, modo, sal, ambos IV y la identidad
del destinatario a ambos contenidos cifrados.

El cuerpo autenticado del token contiene exactamente:

```json
{"artwork_sha256":"...","bits":1,"ciphertext_bytes":1234,"height":2048,"width":3072}
```

La clave derivada para el archivo utiliza HKDF `info` UTF-8
`ASTRA-SECURE-V2/payload`; la del token utiliza `ASTRA-SECURE-V2/token`.
Ambas derivan 256 bits con HKDF-SHA256 y la sal de la cabecera. El cuerpo del
token se cifra con la segunda clave, `token_iv` y la AAD descrita. Las dos
claves AES se crean como `CryptoKey` no exportables.

El token completo se limita a 16 KiB. Su tamaño real se informa tras generarlo.
Integrarlo en el PNG añade exactamente esos bytes más 12 bytes de cabecera/CRC.
Es pequeño porque contiene parámetros para extraer ciphertext, no millones de
asignaciones de la permutación anterior. El tamaño del PNG portador es el costo
principal de transporte.

## Modo secreto

El material de entrada HKDF son 32 bytes aleatorios obtenidos con
`crypto.getRandomValues`. Se entregan por separado como una cadena base64url
sin relleno de 43 caracteres, denominada `recovery_secret`.
El emisor puede suministrar una clave existente de exactamente 32 bytes;
no se aceptan contraseñas humanas como sustituto de esa clave aleatoria.
El receptor proporciona esa clave para derivar las mismas dos claves AES.

Una clave incorrecta o un token alterado produce un error de autenticación.
El PNG y el token juntos no incluyen el secreto. La confidencialidad depende
de mantenerlo separado de personas que no deban recuperar el archivo.

## Modo destinatario

Una identidad local se crea con:

```javascript
crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits'])
```

La clave privada es un `CryptoKey` no exportable. La pública se exporta y
normaliza a una JWK mínima con exactamente `crv:'P-256'`, `kty:'EC'`, `x` e `y`.
La identidad pública compartible es:

```text
{format:'ASTRA-RECIPIENT-V1', publicKey:JWK_minima,
 fingerprint:SHA256(JSON_canonico_de_JWK_minima)}
```

Se valida la huella, las coordenadas de 32 bytes y que Web Crypto acepte el
punto en P-256. La huella debe compararse con el destinatario por un canal de
confianza: comprobar un hash no demuestra por sí solo quién entregó una clave.

El emisor genera una pareja efímera nueva y obtiene 256 bits mediante ECDH
entre su privada efímera y la pública del destinatario. Esos bits son el
material de entrada HKDF. El receptor obtiene los mismos bits con su privada
local y la pública efímera que aparece en la cabecera autenticada.
Se comprueba que su identidad pública coincida con `recipient_fingerprint`.

La clave privada no exportable puede guardarse por clonación estructurada en
IndexedDB. Esto no promete almacenamiento en hardware ni protección frente a
código malicioso que controle el mismo origen del navegador. La clave privada
estática comprometida permite descifrar mensajes antiguos conservados junto
a sus cabeceras: **no se afirma secreto hacia adelante**.
Este modo autentica el contenido respecto de las claves utilizadas; no es una
firma digital del emisor. Cualquier persona con la clave pública del
destinatario puede crearle un mensaje.

## Inserción visual

El portador debe tener entre 1 y 4096 píxeles por lado, como máximo
16 777 216 píxeles. Se usa RGB8. Si llega RGBA, se toman sus tres canales RGB;
la interfaz debe componer la transparencia como desee antes de enviarlo.

Se elige el menor número b de bits entre 1 y 4 que cumpla:

```text
width × height × 3 × b >= ciphertext_bytes × 8
```

Si ningún valor cumple, se devuelve `CAPACITY` con la capacidad máxima y los
bytes necesarios; no se recorta ni pierde contenido.

Se recorre el ciphertext en orden de bytes, del bit más significativo al menos
significativo. Por cada canal RGB consecutivo se toma un grupo de b bits y se
reemplazan sus b bits menos significativos. El último grupo parcial se completa
con ceros a la derecha. Los canales restantes conservan su valor completo.

La diferencia máxima por canal es `2^b−1`. Se calcula el error cuadrático
medio real sobre todos los canales y:

```text
PSNR = 10 × log10(255² / MSE)
```

Si MSE es cero, PSNR es infinito. Se reportan `psnr_db`, `max_channel_delta`
y `bits_per_channel`; no se sustituye una medición por una promesa visual.

La obra base usa PNG RGB8, filtro de fila 0, un IDAT con zlib y solamente
IHDR/IDAT/IEND. La compresión real sin pérdidas se obtiene mediante
`CompressionStream('deflate')` cuando está disponible. Solo se utiliza si su
resultado ocupa menos que DEFLATE almacenado; si no está disponible, falla o
no reduce tamaño, se escriben bloques almacenados de hasta 65 535 bytes como
en la versión anterior. El lector admite ambos. Los píxeles son idénticos en
las dos representaciones; no se usa cuantización ni codificación con pérdidas.

Si se solicita un PNG portátil, se añade un único chunk privado `neBo` antes
de IEND con el token ya cifrado. Los bytes del archivo original cifrado siguen
en los canales RGB; `neBo` contiene únicamente el token y nunca la clave secreta.

## Recuperación y comprobación

1. Validar el contenedor PNG y extraer el token integrado, si existe. Si también
   se proporciona un token externo, exigir que coincida byte por byte.
   Sin token integrado, sigue siendo válido el par antiguo PNG + token externo.
2. Validar la cabecera del token y obtener las claves por el modo indicado.
3. Autenticar y descifrar el cuerpo del token antes de usar sus parámetros.
4. Validar dimensiones, capacidad y longitudes autenticadas.
5. Comparar SHA-256 del PNG base completo, retirando solo `neBo` si existe,
   con el hash dentro del token.
6. Analizar el PNG como bytes, sin canvas ni correcciones de color; verificar
   sus CRC, formato, filtro y tamaño expandido, y extraer el ciphertext RGB.
7. Autenticar y descifrar la trama del archivo con la clave y AAD del contenido.
8. Validar los metadatos privados, extraer el archivo y comprobar su SHA-256.
9. Entregar el archivo solamente tras completar todas las verificaciones.

Cada codificación ejecuta esos pasos inversos y compara además todos los bytes
con el archivo original antes de devolver la obra y el token. Las dos
operaciones AES-GCM usan sal y IV aleatorios nuevos; se espera que dos
codificaciones del mismo archivo produzcan resultados distintos.

## API del worker

Worker de tipo módulo: `new Worker('./secure-worker.js',{type:'module'})`.
Al cargar, emite `{type:'ready',format:'ASTRA-SECURE-V2'}`. Usa el protocolo
habitual `{id,type:'progress'|'result'|'error',...}`.

```javascript
// Secreto nuevo por defecto; recipient selecciona el modo destinatario.
{id,action:'encode',file:ArrayBuffer,name,mime,
 cover:{width,height,data:ArrayBuffer,channels:3|4},
 secret?:string|Uint8Array,recipient?:publicBundle,embed_token?:boolean}

{id,action:'decode',artwork:ArrayBuffer,token?:ArrayBuffer|string,
 secret?:string|Uint8Array,privateKey?:CryptoKey,recipientPublic?:publicBundle}

{id,action:'generate_identity'}
{id,action:'export_public',publicBundle}
```

También exporta `generateIdentity()`, `validatePublicBundle(bundle)`,
`encodeSecure(input,callback)` y `decodeSecure(input,callback)` para importación
como módulo. La importación desde una ventana no registra manejadores de worker.
`estimateCiphertextBytes({file,name,mime})` devuelve síncronamente el tamaño
exacto de la trama cifrada, sin leer el archivo. Acepta File/Blob, bytes o un
objeto `{size:n}`. El cálculo incluye metadatos normalizados, prefijo de 4 bytes
y etiqueta GCM de 16 bytes; un hash provisional de 64 caracteres tiene la misma
longitud que el SHA-256 real.

`generateIdentity` devuelve `{privateKey,publicBundle}`. Codificar devuelve
`artwork`, `token`, `recovery_secret` solamente en modo secreto, los resultados
de integridad y las medidas de calidad. Descifrar devuelve `file`, `name`,
`mime`, `sha256` y `exact_file_recovery:true` cuando la autenticación termina.
Ninguna función del motor hace peticiones de red.

`embed_token` es falso por defecto para preservar la API anterior. Si es
verdadero, `artwork` ya es el PNG portátil y `embedded_token:true`; `token`
sigue devolviéndose como copia externa opcional. `artwork_sha256` y
`artwork_bytes` describen el PNG realmente entregado. `base_artwork_sha256`
y `base_artwork_bytes` describen la imagen normalizada autenticada por el token.
`png_compression`, `uncompressed_png_bytes` y `png_savings_bytes` muestran la
representación elegida, su cota almacenada y el ahorro medido.
