# NEBO-BUNDLE-V1: varios adjuntos íntegros

`bundle.js` reúne hasta 32 adjuntos en un ZIP estándar sin compresión. Cada
archivo conserva sus bytes exactamente, incluidos PDF, imágenes, audio, texto,
GeoJSON, formatos desconocidos y archivos vacíos. Los nombres humanos se
normalizan para que sean seguros. No se interpretan ni modifican los contenidos.

El contenedor **no cifra por sí mismo**. La aplicación entrega el ZIP completo
al motor seguro, que cifra tanto los archivos como el manifiesto. Antes de
ese cifrado, un ZIP descargado permite leer su contenido con una herramienta
ZIP normal. Los hashes detectan cambios respecto del manifiesto, pero no son
firmas digitales; la autenticación criptográfica corresponde al motor seguro.

## API

```javascript
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
export const MAX_BUNDLE_ITEMS = 32;
export const BUNDLE_MIME = 'application/vnd.nebo.bundle+zip';

// kind: 'file' | 'text' | 'voice' | 'location'
const items = [{file: new File([bytes], 'documento.pdf',
                              {type:'application/pdf'}), kind:'file'}];

estimateBundleSize(items); // síncrono: bytes exactos del ZIP final
await createBundle(items); // File: NEBO-envio.zip, MIME BUNDLE_MIME
await readBundle(arrayBufferOrTypedView);
// [{name, mime, kind, bytes:Uint8Array, sha256}]
isBundleMime(mime); // reconoce el MIME sin distinguir mayúsculas ni parámetros
```

`createBundle` también acepta un Blob con `size`, `type` y `arrayBuffer()`;
cuando no hay nombre genera `archivo-0001.bin`, etc. El resultado tiene
`lastModified=0`. El contenido, orden, nombres y tipos idénticos producen
exactamente los mismos bytes ZIP, con independencia de la fecha del sistema.

El estimador usa el tamaño de cada File/Blob y un hash hexadecimal provisional
de 64 caracteres: su longitud coincide con la del SHA-256 real. Incluye el
manifiesto, nombres UTF-8, todas las cabeceras y el directorio ZIP. Puede devolver
un tamaño superior a 20 MiB para que la interfaz lo informe. `createBundle`
rechaza ese caso **antes de leer los bytes de los archivos**.

El límite de 20 MiB corresponde al archivo ZIP completo, no solo a la suma de
adjuntos. Se exige entre 1 y 32 elementos; cada elemento puede tener cero bytes.

## Estructura del ZIP

El orden físico es:

```text
manifest.json
files/0001-<nombre seguro>
files/0002-<nombre seguro>
...
```

Los nombres humanos duplicados son válidos. El índice de cuatro cifras hace
única cada ruta ZIP. No se añaden directorios como entradas independientes.

Perfil ZIP utilizado y aceptado por el lector:

- Método 0: STORE, sin compresión ni descompresión.
- Versión creada y requerida: 20; bandera UTF-8 `0x0800`.
- Fecha DOS: 1 de enero de 1980 (`0x0021`); hora: cero.
- CRC-32 estándar de cada entrada en su cabecera local y central.
- Tamaños comprimido y original iguales, enteros de 32 bits.
- Sin comentarios, campos extra, descriptores posteriores ni cifrado ZIP.
- Sin atributos, enlaces, discos múltiples ni ZIP64.
- Entradas locales contiguas, seguidas del directorio central y el registro
  final EOCD de 22 bytes, sin prefijos, huecos ni datos posteriores.

Es un subconjunto canónico de ZIP. Una herramienta convencional puede abrirlo
y extraerlo; un ZIP que otra herramienta reescriba con fechas, atributos o
compresión diferentes puede ser rechazado por el lector estricto de NEBO.

## Manifiesto

`manifest.json` es JSON UTF-8 estricto, sin BOM, sin espacios adicionales ni
salto de línea final, con claves ordenadas lexicográficamente en cada objeto.
Conserva los caracteres Unicode como UTF-8; usa los escapes normales de JSON
para caracteres que los requieren. No contiene fechas ni identificadores
aleatorios. El esquema exacto es:

```json
{
  "format": "NEBO-BUNDLE-V1",
  "items": [
    {
      "bytes": 123,
      "kind": "file",
      "mime": "application/pdf",
      "name": "documento.pdf",
      "path": "files/0001-documento.pdf",
      "sha256": "64 caracteres hexadecimales en minusculas"
    }
  ],
  "version": 1
}
```

El ejemplo se muestra con sangría para lectura; el archivo real usa JSON
compacto. El manifiesto está limitado a 128 KiB y sus elementos corresponden
uno a uno, en el mismo orden, a las entradas físicas posteriores.

`kind` es una etiqueta de interfaz, no una transformación de datos. Por ejemplo,
`location` puede transportar un archivo `application/geo+json`; `text` conserva
exactamente la codificación y los saltos de línea suministrados; `voice`
conserva el contenedor de audio completo. El lector no ejecuta contenido ni
consulta ubicaciones, mapas o servicios de red.

Los nombres se convierten a Unicode bien formado y NFC, se elimina cualquier
prefijo de ruta y se sustituyen controles, caracteres no admitidos en nombres
Windows, controles bidireccionales y BOM. Se recortan puntos/espacios en los
extremos y se limita la longitud a 160 puntos de código. Los nombres reservados
como `CON.txt` reciben un prefijo `_`. Esta normalización afecta solo al nombre,
nunca a los bytes del archivo.

El MIME se normaliza a minúsculas y se conserva su tipo base, eliminando los
parámetros. Por ejemplo, `audio/webm;codecs=opus` se guarda como `audio/webm`.
Un tipo ausente, demasiado largo o inválido se representa con
`application/octet-stream`. Esta normalización permite adjuntar cualquier
archivo y no modifica sus bytes ni los metadatos contenidos dentro del archivo.
El lector exige que el manifiesto ya use ese tipo base normalizado.

## Validación al recuperar

`readBundle` copia una entrada acotada a 20 MiB y trabaja exclusivamente en
memoria. No extrae rutas al disco. Rechaza:

- registros truncados, firmas incorrectas o directorios fuera de rango;
- entradas superpuestas, offsets no contiguos y datos ocultos;
- discrepancias entre nombres, CRC o tamaños locales y centrales;
- cualquier compresión, cifrado ZIP, atributo o extensión no admitidos;
- nombres ZIP repetidos, UTF-8 inválido y rutas diferentes de las generadas
  a partir del nombre seguro y su índice;
- claves JSON repetidas, campos desconocidos o manifiesto no canónico;
- cantidades, etiquetas, tipos, hashes o longitudes inválidos;
- cualquier CRC-32 incorrecto o SHA-256 que no coincida con el manifiesto.

La implementación nunca infla datos, por lo que no admite bombas basadas en
compresión ZIP. Los CRC verifican la estructura ZIP y los SHA-256 verifican
los bytes de cada adjunto. Los resultados solo se entregan después de validar
todos los elementos; cada `bytes` devuelto es una copia independiente.

## Comprobación ejecutada

`tests/test_bundle.mjs` cubre mezclas de tipos, Unicode y normalización NFC,
nombres duplicados, archivos vacíos, determinismo, estimación exacta, CRC,
SHA-256 incluso con CRC reparado, rutas, solapamientos, perfiles comprimidos,
UTF-8 inválido, archivos truncados y límites de tamaño/cantidad.

Se ejecutó un caso en el límite exacto de **20 971 520 bytes** de ZIP y un caso
de 32 archivos vacíos. También se cifró el ZIP mixto con `encodeSecure` en un
portador de 256×256, se rechazó una clave incorrecta y se descifró con la clave
correcta: el ZIP, cada archivo y todos sus hashes coincidieron exactamente.
El informe está en `tests/BUNDLE_REPORT.json`.

```text
node tests/test_bundle.mjs
```

El módulo usa únicamente APIs estándar de navegador y Node 22 o posterior:
File/Blob, UTF-8, TypedArray/DataView y Web Crypto SHA-256. No añade dependencias
ni realiza peticiones de red.
