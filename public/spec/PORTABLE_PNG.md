# PNG portátil: token integrado y compresión sin pérdidas

El envío seguro puede transportarse como **una imagen PNG más la clave secreta
o identidad del destinatario**. El mismo token cifrado `ASTRA-SECURE-V2` de los
envíos anteriores se integra en un único chunk PNG privado `neBo`. Este cambio
empaqueta los datos existentes; no introduce un algoritmo criptográfico nuevo
ni guarda la clave secreta en el token o en la imagen.

## Estructura exacta

La imagen base conserva el perfil RGB8, sin entrelazado, con chunks:

```text
firma PNG | IHDR | IDAT | IEND
```

La variante portátil es:

```text
firma PNG | IHDR | IDAT | neBo | IEND
```

`neBo` es un chunk auxiliar y privado: `n` y `e` minúsculas, tercera letra `B`
mayúscula según el bit reservado PNG y `o` minúscula. Contiene los bytes UTF-8
exactos del token cifrado V2. Su longitud es de 1 a 16 384 bytes; suma 12 bytes
de longitud, tipo y CRC-32. Se admite una sola ocurrencia, únicamente entre
IDAT e IEND. Los lectores PNG estándar pueden ignorarla y mostrar la imagen.

El token mantiene su cabecera pública acotada y su cuerpo AES-GCM cifrado.
No se admiten campos adicionales que introduzcan un secreto, nombres originales
o datos sin cifrar. La validación del envoltorio no sustituye a la autenticación:
el motor seguro autentica el token y el contenido antes de devolver un archivo.

## Hash sin dependencia circular

El campo `artwork_sha256` dentro del cuerpo cifrado del token sigue siendo el
SHA-256 del **PNG base**, no del PNG que ya contiene ese mismo token.

Para verificar un PNG portátil se elimina exclusivamente el chunk `neBo`
completo, manteniendo todos los demás bytes exactamente iguales. El resultado
debe coincidir con el hash autenticado. No se recomprimen píxeles, no se reescriben
otros chunks y no se eliminan metadatos arbitrarios para hacer coincidir el hash.

Así se evita el ciclo de intentar incluir el hash de un archivo dentro del
mismo archivo que se está calculando. El token conserva su autenticación AES-GCM
y su vínculo con la imagen base; un token válido de otro envío no autentica
esta imagen.

Los resultados del emisor distinguen:

- `artwork_sha256`: hash del PNG completo que se descarga realmente.
- `base_artwork_sha256`: hash del PNG base autenticado dentro del token.
- `artwork_bytes` y `base_artwork_bytes`: sus tamaños respectivos.

Eliminar `neBo` no permite recuperar el archivo usando solo la imagen y la
clave: vuelve a hacer falta la copia externa del token. Si se conserva esa copia
correcta, el PNG base sigue siendo un envío V2 válido; esta compatibilidad es
intencional. El envoltorio no promete detectar una extracción legítima del token
como si fuera una firma sobre la forma externa del transporte.

## Validación estricta

`portable-png.js` comprueba antes de extraer:

- firma PNG, longitudes y final exacto sin bytes adicionales;
- perfil IHDR RGB8 no entrelazado y dimensiones de 1 a 4096 por lado;
- orden exacto IHDR, un IDAT, neBo opcional e IEND;
- CRC-32 de todos los chunks, incluido el token;
- token único, dentro de su cuota y con UTF-8 válido;
- JSON sin claves duplicadas, versión V2 y esquema público exacto;
- formatos y longitudes de sal, IV, cuerpo cifrado y clave pública efímera;
- ausencia de chunks desconocidos o cargas auxiliares no admitidas.

El PNG base está limitado a `4096×4096×3 + 100000` bytes. El contenedor permite
como máximo esa cantidad más `16384+12` bytes. Después, el motor seguro valida
el hash base, descomprime con límites derivados de las dimensiones autenticadas,
extrae el ciphertext RGB y ejecuta las comprobaciones AES-GCM y SHA-256 existentes.

Si se proporciona un token externo a la vez que uno integrado, sus bytes deben
coincidir exactamente. No se elige silenciosamente uno de dos tokens distintos.

## Compresión real sin pérdidas

El encoder conserva filtro PNG 0 y una sola secuencia IDAT zlib, pero puede
comprimirla mediante `CompressionStream('deflate')`. Solo elige esa salida
si es menor que la representación de bloques DEFLATE almacenados. Si no existe
CompressionStream, falla o no hay ahorro, usa el formato almacenado anterior.

Ambas variantes contienen exactamente los mismos bytes de píxeles. El lector
usa descompresión zlib nativa y no canvas, evitando conversiones de color o
premultiplicación. La compresión no modifica el número de píxeles, el contenido
LSB cifrado, la calidad medida ni el archivo recuperado.

Para W×H RGB, la cota de tamaño base de la representación almacenada es:

```text
raw = (3×W + 1) × H
stored_png = raw + 5×ceil(raw/65535) + 63
portable_upper_bound = stored_png + 16384 + 12
```

El resultado real se mide después de comprimir. Las fotografías, ilustraciones
y zonas de color plano tienen compresibilidades diferentes; no se promete el
mismo porcentaje de ahorro para todas las imágenes. Dos implementaciones zlib
pueden producir bytes comprimidos distintos con los mismos píxeles. El token
autentica los bytes concretos que se generaron en cada envío.

## API y compatibilidad

```javascript
import {
  packPortablePNG, unpackPortablePNG, extractEmbeddedToken
} from './portable-png.js';

packPortablePNG(baseArtwork, token); // Uint8Array; rechaza un PNG ya integrado
unpackPortablePNG(input);           // {artwork:Uint8Array, token:Uint8Array|null}
extractEmbeddedToken(input);        // Uint8Array|null, sin reconstruir el PNG base
```

Las tres funciones son síncronas, locales y no necesitan claves. Validan la
estructura; no descifran ni consideran autenticado el token por haberlo leído.
Un PNG antiguo sin neBo devuelve sus bytes base intactos y `token:null`.
La copia externa sigue funcionando con el decoder actualizado y los motores
antiguos pueden recibir el PNG base extraído y el token V2 correspondiente.

```javascript
const result = await encodeSecure({...input, embed_token:true});
const original = await decodeSecure({artwork:result.artwork, secret});
```

En modo destinatario se suministran `privateKey` y `recipientPublic` en lugar
de `secret`. Por compatibilidad, `encodeSecure` mantiene `embed_token:false`
por defecto; la interfaz puede activarlo para sus nuevos envíos. La copia de
`result.token` continúa disponible como respaldo opcional.

## Verificación ejecutable

`tests/test_portable_png.mjs` comprueba recuperación exacta usando solo PNG y
clave, modo destinatario, clave incorrecta, sustitución y edición de token,
duplicados, UTF-8 inválido, truncamientos, cuotas, discrepancias con token externo,
retirada del chunk, compatibilidad con bloques almacenados y compresión real.

`tests/verify_portable_png.py` abre ambos PNG con Pillow, verifica sus CRC y
compara todos sus píxeles con una lectura independiente de zlib en Node.
El resultado exigido es cero píxeles distintos entre PNG base y portátil.
Los informes se guardan en `PORTABLE_CODEC_REPORT.json` y
`PORTABLE_PILLOW_REPORT.json` dentro de `tests`.
