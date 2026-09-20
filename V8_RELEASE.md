# Vista previa inmediata y envío en un solo PNG

La versión de interfaz 8 muestra la portada desde la primera pantalla: en el
móvil encima del editor, en escritorio dentro del panel de salida. Cambiar la
portada o su acabado actualiza esa vista sin generar un envío. La imagen final
solo se ofrece para compartir después de verificar la recuperación.

El editor de texto queda visible y su borrador se añade al pulsar Crear. Fotos,
archivos, voz y ubicación tienen controles separados. La personalización de
portada es opcional. El receptor ve la portada inmediatamente y abre el contenido
con el PNG y su clave, o con su identidad privada local.

## Cambios de formato y capacidad

- Los nuevos PNG privados contienen un bloque `neBo` con el token cifrado.
  No incluye la clave secreta ni ninguna clave privada. El token externo queda
  disponible como copia opcional. Los formatos anteriores siguen admitidos.
- El token autentica el PNG base exacto obtenido al retirar `neBo`, sin un hash
  circular. Se rechazan modificaciones, duplicados y tokens externos discrepantes.
- Compresión PNG DEFLATE sin pérdida, con fallback almacenado compatible.
- Dimensiones automáticas entre 1024 y 4096 px según la capacidad requerida;
  formatos y resoluciones manuales opcionales. No se redimensionan los adjuntos.
- Hasta 32 elementos y 20 MiB, incluido el contenedor del envío.

## Contactos e instalación

La libreta guarda hasta 50 identidades públicas con alias, tras confirmar su
huella. Las importaciones tardías no sustituyen un contacto elegido mientras
se estaba leyendo otro archivo. Cada envío fija su destinatario antes de cifrar.

La PWA guarda solo 20 recursos estáticos para abrir la app y recuperar mensajes
sin red. No hay caché de envíos ni secretos. La instalación depende del navegador;
las pruebas de Edge no equivalen a una instalación comprobada en iOS o Android.

## Evidencia ejecutada

- `tests/PORTABLE_CODEC_REPORT.json`: 22 casos de formato, criptografía,
  corrupción, compatibilidad y fallback de compresión.
- `tests/PORTABLE_PILLOW_REPORT.json`: lector PNG independiente; cero píxeles
  diferentes entre PNG base y portátil.
- `tests/MULTI_MESSAGE_REPORT.json`: 14 grupos; ocho elementos recuperados
  exactamente en otro contexto sin red, con PNG y clave solamente.
- `tests/V8_USERFLOW_REPORT.json`: vista previa, creación de texto con un clic,
  compartir solo PNG, recepción, clave incorrecta y libreta de contactos.
- `tests/PWA_CONTACTS_REPORT.json`: 12 grupos; cierre completo y arranque de
  otro proceso Edge sin conexión, claves/contactos persistentes, recuperación.
- `tests/PWA_FAILURE_REPORT.json`: instalación incompleta rechazada sin borrar
  cachés anteriores o ajenas.
- `tests/RECIPIENT_RACE_REPORT.json`: una importación pendiente de A no sustituye
  al contacto B; B abre el PNG y A es rechazado.
- `tests/ui-v8/`: revisión visual en 320, 390 y 1440 px, claro/oscuro.

Las pruebas usan contenido sintético y no imprimen claves secretas. Los hashes
de cada informe corresponden a su ejecución; el cifrado genera nuevos valores
aleatorios en cada envío. Los informes públicos de esta versión se conservan
separados de los informes históricos.
