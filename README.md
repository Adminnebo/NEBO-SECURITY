# ASTRA Web: enviar una obra y reconstruir el archivo

Aplicación estática en español. El procesamiento se ejecuta en un Web Worker del navegador. No tiene API que reciba el archivo original, base de datos, servicio de reconstrucción ni claves de acceso remotas.

## Prueba entre dos personas

1. El emisor abre la dirección HTTPS, elige Crear envío y carga un PDF, imagen o archivo de audio; también puede escribir texto o grabar una nota de voz con permiso del micrófono.
2. Convierte y descarga AMBOS archivos: la obra PNG y el token JSON.
3. Envía el enlace de recepción y los dos archivos por su mensajería habitual. El PNG se envía **como archivo/documento**, evitando que el servicio lo recomprima o cambie de tamaño.
4. La otra persona abre Reconstruir recibido, selecciona esos dos archivos y descarga el original recuperado. No debe tener ni recibir el original.
5. La interfaz comprueba el SHA-256 del contenido recuperado. Una alteración del PNG o token se rechaza.

No hay un chat con entrega automática ni almacenamiento en nube en esta versión. Compartir el enlace no envía el archivo: los dos adjuntos son imprescindibles. El token completo puede ser grande; la aplicación muestra su tamaño real.

## Qué se conserva

ASTRA-MSG-V1 extiende la demostración estricta de permutar píxeles de una página. La matriz fuente contiene una vista RGB opcional, **todos los bytes del archivo original como canales RGB**, y relleno cero. La obra es una permutación biyectiva de esa matriz completa. Este diseño permite conservar un PDF entero, el alfa y metadatos de imágenes, o el audio completo. No pretende que los bytes de audio ya fueran píxeles de un documento renderizado.

El paisaje se usa exclusivamente para elegir posiciones. No se incorporan sus colores a la obra. El resultado depende de la paleta y la distribución de valores de la fuente: un documento blanco produce una obra mayormente blanca, no una fotografía a todo color. El token almacena la permutación y metadatos, no una copia del archivo.

La transformación verifica la recuperación antes de habilitar las descargas. No se trata de cifrado; una persona con la obra y el token puede leer el mensaje. Los hashes detectan alteraciones, no acreditan la identidad de un remitente.

## Portabilidad y funcionamiento sin red

El receptor solo necesita el PNG, el token y esta implementación pública del algoritmo. El worker se carga al abrir la página. Una vez cargado, la recuperación se puede ejecutar sin conexión, sin consultar el original ni el paisaje. Para volver a abrir la página después de cerrarla se necesita la conexión o una copia local de la aplicación.

El visor PDF del emisor usa PDF.js 6.3.289 vendorizado; no consulta CDN. La grabación requiere HTTPS o localhost y permiso del micrófono. La grabación crea WAV PCM sin compresión. La recuperación no necesita PDF.js ni el micrófono.

Navegador recomendado para esta prueba: Edge o Chrome actual. Límite de archivo de entrada: 20 MiB; el consumo de memoria de matrices y ordenación puede limitar teléfonos con poca memoria. La interfaz comunica los errores y no declara una reconstrucción correcta si fallan los hashes.

## Ejecutar una copia local

Desde esta carpeta:

```powershell
python -m http.server 8770 --bind 127.0.0.1 --directory public
```

Abrir http://localhost:8770. Para compartir fuera del equipo se necesita la dirección HTTPS publicada; localhost solo apunta al equipo donde se abre.

Las especificaciones del formato se encuentran en `public/spec/`. El codec portable está en `public/codec-worker.js`. Las pruebas independientes están en `tests/` y sus resultados se guardan en `WEB_VALIDATION_REPORT.json`.
