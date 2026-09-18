# Formato ASTRA-MSG-V1

Cada mensaje conserva el archivo original completo, byte por byte. La obra PNG
y el token JSON permiten recuperarlo sin el archivo original, sin la base de
datos de la aplicación y sin el paisaje de referencia.

## Diferencia con la primera prueba

La primera prueba conservaba solamente los píxeles de una página renderizada.
Esta aplicación usa una extensión explícita: la matriz fuente contiene los
píxeles RGB de una vista opcional, **todos los bytes del archivo original
interpretados como canales RGB**, y relleno cero. Así conserva también las
páginas de un PDF que no aparecen en la vista, el alfa y los metadatos de una
imagen, y el contenedor y las muestras originales de un audio.

El token contiene posiciones y metadatos; no contiene una copia oculta del
archivo original ni muestras RGB adicionales. Los datos completos viajan en
los píxeles de la obra. El paisaje de referencia solamente determina dónde
colocar esos píxeles.

## Matriz y permutación

1. Se acepta un archivo de 1 byte a 20 MiB. La vista tiene como máximo 2 millones
   de píxeles: primera página del PDF hasta 120 DPI, imagen RGB o extracto de
   texto. Para audio no se necesita una vista ni transcripción.
2. Se concatena `RGB_de_la_vista || bytes_del_archivo || relleno_cero`.
   Si Q es el tamaño sin relleno, N = ceil(Q/3), W = ceil(sqrt(N×8.5/11)) y
   H = ceil(N/W). Se completa hasta W×H×3 bytes y se interpreta como RGB8.
3. Se reordena cada píxel individual mediante el algoritmo determinista del
   motor ASTRA. La matriz completa tiene como máximo 12 millones de píxeles.
4. El motor comprueba la igualdad exacta de los multiconjuntos RGB y codifica
   una permutación biyectiva. El token guarda rangos ordenados por RGB,
   diferencias con signo, zigzag, LEB128, zlib y Base85. No depende de una semilla
   diminuta capaz de describir una permutación arbitraria.
5. Antes de publicar el resultado, la aplicación reconstruye el archivo,
   compara sus bytes y SHA-256, y compara directamente los píxeles originales
   y reconstruidos. Los resultados válidos tienen cero píxeles distintos.

## Paquete y token

El ZIP transportable contiene exactamente:

- `artwork.png`: todos los píxeles de la matriz, reordenados.
- `token.json`: token completo `ASTRA-MSG-V1`.
- `LEEME.txt`: instrucciones breves.

La vista `preview.png` sirve a la interfaz y no es necesaria para recuperar.
El límite del ZIP es 70 MiB tanto comprimido como expandido; el del token es
48 MiB. La aplicación muestra el tamaño real de todo el token, incluido el
JSON y Base85. El tamaño depende del archivo; no hay promesa de una clave
pequeña para cualquier contenido.

El JSON tiene estos campos: `format`, `filename`, `mime_type`, `kind`,
`render_scope`, `source_sha256`, `file_bytes`, `payload_byte_offset`,
`padding_bytes`, `preview`, `engine_token` y `checksum_sha256`.
`preview` es nulo o contiene `width`, `height` y `rgb_sha256`.
`engine_token` es el token de rangos del motor original. El checksum exterior
es SHA-256 del JSON ASCII con claves ordenadas y sin espacios, excluyendo el
campo `checksum_sha256`. Se añade un salto de línea al archivo final.

## Recuperación independiente

El decodificador verifica el token, reconstruye la matriz y aplana sus bytes
RGB. El archivo original ocupa el intervalo:

```text
[payload_byte_offset, payload_byte_offset + file_bytes)
```

Comprueba el SHA-256 de ese intervalo, el de la vista y que el relleno sea cero.
La especificación detallada del motor está en `engine/CODEC_SPEC.md`; la
extensión se documenta también en `PAYLOAD_FORMAT.md`.

```powershell
python recuperar.py --package package.zip --output archivo_recuperado.pdf
python recuperar.py --artwork artwork.png --token token.json --output voz_recuperada.wav
```

El programa rechaza sobrescribir una salida existente salvo que se indique
`--force`. La extensión de salida debe corresponder al archivo original; el
programa informa su nombre, tamaño y SHA-256 verificado.

Este mecanismo aporta reversibilidad y comprobación de integridad. No utiliza
AES, no cifra el contenido y sus hashes no constituyen una firma digital.
Otra persona con la obra y el token puede reconstruir el mensaje.
