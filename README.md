# NEBO AI - SECURITY

Interfaz móvil con temas claro y oscuro. El botón de sol/luna de la cabecera
cambia el tema y recuerda la selección en este navegador. La primera visita
usa la preferencia de color del dispositivo.

La identidad visual utiliza el logo oficial suministrado por el propietario,
conservado sin alterar en `public/assets/nebo-logo-original.png`. El encuadre CSS
elige la variante superior para el tema claro y la inferior para el oscuro.
La interfaz combina tonos perla y carbón; los estados conservan su color semántico.

Repositorio: https://github.com/Adminnebo/NEBO-SECURITY

Web: https://astra-pixel-mensajes-lucas.lucasarmando417.chatgpt.site

Receptor: https://astra-pixel-mensajes-lucas.lucasarmando417.chatgpt.site/?modo=recibir

Aplicación estática en español. El navegador cifra y recupera el archivo; no
hay API que reciba originales o secretos ni base de datos de mensajes. Las
funciones criptográficas proceden de Web Crypto.

## Primera prueba privada

La portada se ve desde la primera pantalla, en móvil y escritorio. Escribe un
mensaje o añade adjuntos y pulsa **Crear imagen privada**. El texto del editor
se incluye automáticamente. **Cambiar portada** abre la personalización opcional;
el formato y la resolución se calculan automáticamente según el contenido.

Si el navegador admite compartir archivos, aparece un botón para enviar el
PNG con el menú del dispositivo. El token cifrado ya está integrado en ese PNG;
la clave secreta queda fuera de esa selección. También puedes descargar el PNG
y guardar una copia opcional del token por separado.

1. Añade uno o varios archivos de cualquier tipo: fotos, PDF, audio, video u otros.
   También puedes añadir mensajes escritos, grabar notas de voz e incluir ubicaciones.
   Cada selección se agrega al envío; puedes quitar elementos por separado.
2. Puedes cambiar la portada sugerida por otra o subir una propia. La portada
   queda visible: usa una imagen que puedas compartir. La resolución manual
   permite 2K, 4K o hasta 4096 px; el ajuste automático suele producir archivos menores.
3. Crea el envío. Se cifra el archivo y se verifica su recuperación antes de
   habilitar la descarga del PNG con su token cifrado integrado.
4. Guarda la clave secreta generada. No está dentro del PNG ni del token.
   Compártela por un canal separado y protegido. Si la pierdes, no existe una
   clave maestra del servidor que permita recuperar el archivo.
5. Envía el PNG junto con el enlace del receptor. En WhatsApp, adjunta el
   PNG como documento/archivo, sin recomprimir.
6. El receptor selecciona el PNG, ve su portada inmediatamente y aporta la
   clave secreta. No necesita el original ni descargar un token adicional.
   Para un envío anterior, abre **Token separado de un envío anterior**.

## Varios elementos en una sola imagen

Un envío admite hasta **32 elementos y 20 MiB en total**, incluido el contenedor.
La capacidad de la portada también depende de su resolución; la interfaz indica
si hace falta una imagen mayor. Todos los elementos y el token cifrado viajan
dentro de **un PNG**; la clave secreta se comparte aparte en el modo privado habitual.

El receptor ve primero los mensajes escritos, después fotos, audio y otros
elementos. Puede descargar cada uno,
reproducir audios o guardar todo en un ZIP. Los bytes originales se conservan;
los elementos con el mismo nombre tienen rutas independientes dentro del ZIP.
Los nombres, tipos, ubicaciones y el manifiesto se cifran junto al contenido.
La [especificación del contenedor](public/spec/BUNDLE_FORMAT.md) documenta el formato.
Los envíos anteriores de un solo archivo siguen abriéndose.

Para incluir una ubicación, introduce sus coordenadas o pulsa **Usar mi ubicación**.
La app solo consulta la ubicación del dispositivo al pulsar ese botón y tras el
permiso del navegador. Revisa los datos y pulsa **Añadir ubicación**. No hay
seguimiento continuo. El receptor puede leer las coordenadas sin conexión;
abrirlas en OpenStreetMap es una acción opcional que requiere conexión.

## Identidad opcional del destinatario

El receptor crea una identidad en su navegador y exporta solo su clave pública.
El emisor la importa y verifica su huella por otro canal. La clave privada es
una CryptoKey no exportable guardada en IndexedDB y no viaja en el paquete.

Después de verificar la huella puedes guardar hasta 50 contactos con nombre.
La libreta guarda únicamente identidades públicas en este navegador. Elegir
un contacto permite cifrar otro envío para él sin importar su archivo de nuevo.
Eliminar un contacto no elimina ninguna identidad privada.

No hay respaldo exportable de esa identidad privada. Borrar los datos del
sitio o perder el perfil puede impedir abrir mensajes dirigidos a ella. Para
la primera prueba portable, usa el modo de clave secreta guardada aparte.
No exportable no garantiza protección por hardware: código malicioso del
mismo origen o un equipo comprometido puede usar la clave mientras está abierta.

## Color, resolución y formato real

ASTRA-SECURE-V2 cifra el archivo y sus metadatos con AES-256-GCM. Los datos
cifrados se guardan dentro de los bits menos significativos de los canales RGB
de la portada. El token está cifrado y autentica los parámetros y el PNG base
completo. El PNG portátil añade el token en un bloque privado `neBo`; quitar ese
bloque recupera exactamente el PNG base autenticado, evitando un hash circular.
El decodificador comprueba CRC, cifrado autenticado y hashes antes de mostrar
el contenido. La [especificación portátil](public/spec/PORTABLE_PNG.md) explica
cómo implementarlo independientemente y abrir también los pares anteriores.

El modo privado **no es una permutación de los píxeles del documento legible**.
Usa una portada pública como imagen portadora de información cifrada. El modo
clásico ASTRA-MSG-V1 continúa como permutación exacta de su matriz original,
marcado sin cifrado. Los paquetes clásicos siguen siendo recuperables.

Las salidas privadas permiten 2K, 4K y hasta 4096 × 4096, según capacidad y
memoria. Ampliar una portada pequeña no añade detalle óptico; la interfaz lo
informa. Los estilos se calculan localmente. Las sugerencias son imágenes
generadas previamente con imagegen; no hay un servicio de IA en la web que
reciba las imágenes que subes.

Archivo máximo: 20 MiB. La capacidad depende de dimensiones y bits de carga.
En teléfonos conviene empezar con archivos pequeños. El PNG usa compresión
DEFLATE real sin pérdida, con fallback compatible, pero puede pesar más que
el original. Antes de crear se muestra un límite superior de tamaño; después,
el tamaño real del PNG. El token cifrado suele ocupar unos KB y puede descargarse
para consultar su tamaño exacto. No se comprimen con pérdida los adjuntos.

## Instalar y recuperar sin conexión

En **Ayuda → Instalar aplicación**, usa el instalador del navegador cuando esté
disponible. En Safari iOS: Compartir → Añadir a pantalla de inicio. También
puedes usar la web sin instalarla. Espera el estado **Aplicación guardada**
en Ayuda antes de desconectarte por primera vez.

La caché conserva solo los 20 recursos estáticos de la aplicación. No guarda
adjuntos, PNG de envíos, tokens ni claves secretas. Se verificó el arranque en
un proceso de navegador nuevo y sin red, seguido de recuperación exacta.
Las actualizaciones esperan a que cierres las pestañas de NEBO; no interrumpen
una conversión activa. La instalación y la conservación del almacenamiento
dependen del navegador. [Detalles de PWA y contactos](public/spec/PWA_AND_CONTACTS.md).

## Implementación y pruebas

- `public/secure-worker.js`: cifrado, transporte RGB y recuperación V2.
- `public/portable-png.js`: integración y extracción del token cifrado `neBo`.
- `public/cover-planner.js`: capacidad y dimensiones automáticas sin cambiar adjuntos.
- `public/contact-store.js`: libreta local de identidades públicas verificadas.
- `public/sw.js`, `public/install.js`: caché estática, instalación y estado offline.
- `public/identity-store.js`: identidad privada local y exportación pública.
- `public/codec-worker.js`: compatibilidad y permutación clásica.
- `public/spec/SECURE_CODEC.md`: especificación interoperable V2.
- `public/spec/SECURITY.md`: controles, modelo de amenaza y límites reales.
- `tests/secure_audit_core.py`: validación independiente de criptografía/formato.
- `tests/`: pruebas de interfaz, voz, conservación y compatibilidad.
- `tests/mobile_ux_test.py`: recorridos móviles con descargas reales,
  reconstrucción sin conexión y controles táctiles. El informe indica los
  tamaños emulados; no equivale a probar un teléfono físico.
- `public/assets/IMAGE_PROVENANCE.json`: prompts y procedencia de portadas.

Se usan cifrado autenticado, claves independientes, validación de entradas,
protección de metadatos, recursos locales, CSP y HTTPS. No se implementan
Double Ratchet, garantías poscuánticas ni certificación externa. Cifrar para
el receptor no firma la identidad del remitente. Las pruebas automatizadas no
sustituyen una auditoría externa para datos de alta sensibilidad.

En la publicación V2 se comprobó que el alojamiento no aplica el archivo
`public/_headers`: las cabeceras HTTP adicionales solicitadas no aparecieron
en la respuesta. La CSP de la página se declara mediante una etiqueta meta.
No se atribuye al despliegue protección de cabeceras que no se haya observado.

El ZIP de entrega incluye casos de prueba sintéticos y los informes reales de
la web pública. No incluye claves privadas ni secretos de mensajes del usuario.
Las instrucciones para repetir las pruebas están en `SECURITY_TEST_REPORT.md`.

## Ejecutar localmente

```powershell
git clone https://github.com/Adminnebo/NEBO-SECURITY.git
cd NEBO-SECURITY
python -m http.server 8770 --bind 127.0.0.1 --directory public
```

Abrir http://localhost:8770. La dirección pública funciona sin ese servidor
ni la computadora del emisor. `package_site.py` prepara únicamente los activos
estáticos del commit para publicar. Las credenciales temporales de publicación
no se guardan en el repositorio.

La aplicación no necesita una API, una clave de OpenAI ni instalar paquetes
de JavaScript para funcionar. Sirve la carpeta `public` mediante localhost
o un alojamiento HTTPS; abrir el HTML directamente como archivo no basta
para todas las funciones del navegador.

## Repetir las comprobaciones

Los casos sintéticos de `tests/fixtures` están incluidos en este repositorio.
Con el servidor local anterior activo, las pruebas de cifrado y de interfaz
se pueden repetir en otra terminal:

```powershell
python -m pip install -r tests/secure_audit_requirements.txt
python tests/secure_audit_core.py --base-url http://127.0.0.1:8770
node tests/test_cover_planner.mjs
node tests/test_portable_png.mjs
python tests/verify_portable_png.py
python tests/v8_userflow_test.py --base-url http://127.0.0.1:8770
python tests/multi_message_test.py --base-url http://127.0.0.1:8770
python tests/pwa_contacts_test.py --base-url http://127.0.0.1:8770
python tests/recipient_race_test.py --base-url http://127.0.0.1:8770
```

Los scripts usan Microsoft Edge en Windows. `MOBILE_RELEASE.md` explica el
resultado de la interfaz móvil y el aviso CSP observado en el alojamiento
público. Los informes antiguos conservan los resultados de sus versiones;
`tests/V8_USERFLOW_REPORT.json`, `tests/PWA_CONTACTS_REPORT.json` y
`tests/PORTABLE_CODEC_REPORT.json` documentan las pruebas de esta actualización.
Estas pruebas usan navegadores de escritorio y tamaños móviles emulados;
no equivalen a una prueba en teléfonos físicos o a una auditoría externa.
