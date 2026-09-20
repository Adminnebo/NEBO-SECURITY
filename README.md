# NEBO AI - SECURITY

**Versión 11: usuarios y contraseñas de NEBO.** El administrador crea una cuenta
para cada persona desde **Mi cuenta → Personas con acceso → Crear usuario**.
El botón **Copiar enlace, usuario y contraseña** prepara los datos para compartir.
La otra persona entra con esas credenciales; no necesita una cuenta de ChatGPT.
No existe registro público. La rama `version-11-usuarios-nebo` conserva esta
modalidad por separado de `version-10-acceso-privado` y las versiones anteriores.

La pantalla de login es pública. Un Worker comprueba la sesión en el servidor
antes de entregar la aplicación y sus recursos privados. Una base de datos D1
conserva las cuentas y sesiones entre publicaciones. La contraseña de la cuenta
abre la app; **no sustituye la clave secreta de un envío** ni permite recuperar
mensajes sin ella. [Diseño y límites del acceso](public/spec/NATIVE_AUTH.md).

La app necesita conexión para comprobar la autorización al entrar y antes de
crear o abrir un envío. Una sesión que deja de verificarse se cierra y descarta
los datos de trabajo en memoria. Las identidades locales de recepción se conservan.

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

Aplicación web en español con autenticación de servidor. El navegador cifra y
recupera los archivos; las API de cuenta reciben credenciales y datos de acceso,
pero no reciben los originales, el contenido de los mensajes ni sus claves de
cifrado. No hay una base de datos de mensajes. El cifrado del envío usa Web Crypto.

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
5. Crea primero el usuario del receptor en **Mi cuenta → Personas con acceso**.
   Envía el PNG junto con el enlace del receptor. En WhatsApp, adjunta el
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

## Instalar en el móvil y comprobar acceso

En **Ayuda → Instalar aplicación**, usa el instalador del navegador cuando esté
disponible, o pulsa el icono de instalación de la cabecera. En Safari iOS:
Compartir → Añadir a pantalla de inicio. Al abrirla desde el icono instalado,
un navegador compatible muestra una ventana de app sin la barra habitual.
La dirección sigue existiendo y se muestra si abres NEBO como pestaña web.

La versión privada no guarda la app para reabrirla sin conexión. Cada petición
llega al servidor; una denegación o un fallo de red nunca devuelve la app desde
la caché. La actualización elimina solo las cachés antiguas de NEBO y conserva
IndexedDB, sus identidades y contactos. La instalación depende del navegador.
[Acceso actual, sesiones y migración](public/spec/NATIVE_AUTH.md).

Las versiones anteriores ya descargadas o clonadas no pueden revocarse a
distancia. Su código y las pruebas de recuperación offline permanecen en las
ramas anteriores; esos informes no describen la política de acceso actual.

## Implementación y pruebas

- `public/secure-worker.js`: cifrado, transporte RGB y recuperación V2.
- `public/portable-png.js`: integración y extracción del token cifrado `neBo`.
- `public/cover-planner.js`: capacidad y dimensiones automáticas sin cambiar adjuntos.
- `public/contact-store.js`: libreta local de identidades públicas verificadas.
- `worker/index.js`, `worker/auth.js`: autorización real, sesiones y administración.
- `public/access.js`: comprueba `/api/auth/session` antes de abrir la aplicación.
- `public/login.js`, `public/account.js`: acceso y gestión de cuentas.
- `public/account-storage.js`: organiza identidades y contactos locales por cuenta.
- `public/sw.js`, `public/install.js`: transporte sin caché e instalación privada.
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

En la antigua publicación estática V2 se comprobó que el alojamiento no aplica el archivo
`public/_headers`: las cabeceras HTTP adicionales solicitadas no aparecieron
en la respuesta. La CSP de la página se declara mediante una etiqueta meta.
La versión 11 establece sus cabeceras desde el Worker, incluida CSP y `no-store`.

El ZIP de entrega incluye casos de prueba sintéticos y los informes reales de
la web pública. No incluye claves privadas ni secretos de mensajes del usuario.
Las instrucciones para repetir las pruebas están en `SECURITY_TEST_REPORT.md`.

## Ejecutar localmente

La versión 11 necesita el Worker y D1; `python -m http.server` no implementa su
autenticación. Instala las dependencias de desarrollo con `npm ci`, configura
el secreto local `NEBO_BOOTSTRAP_ADMIN_JSON` en `.dev.vars` y genera los recursos
con `python package_site_worker.py --dev-assets`. Ejecuta Wrangler con
`wrangler.local.jsonc`, usando HTTPS para probar las cookies `Secure` y el
service worker. El [documento de autenticación](public/spec/NATIVE_AUTH.md)
describe el bootstrap. No incluyas `.dev.vars` ni contraseñas en Git.

`package_site_worker.py` crea el paquete de publicación a partir del commit,
con los recursos privados dentro del módulo del Worker. No necesita una clave
de OpenAI. La web publicada funciona sin la computadora del emisor.

## Repetir las comprobaciones

Los casos sintéticos de `tests/fixtures` están incluidos. La suite del backend
usa SQLite real y el scrypt de Node; no requiere credenciales del usuario:

```powershell
python package_site_worker.py --dev-assets
node tests/native_auth_backend_test.mjs
node tests/test_cover_planner.mjs
node tests/test_portable_png.mjs
python tests/verify_portable_png.py
```

`tests/NATIVE_AUTH_BACKEND_REPORT.json` documenta 22 comprobaciones del backend;
`tests/NATIVE_AUTH_BROWSER_REPORT.json` documenta ocho recorridos sobre el Worker
y D1 locales con navegador real. Los informes de flujo verifican también el
PNG portable y su recuperación exacta. Consulta los informes para distinguir
pruebas locales de pruebas de despliegue. Las pantallas móviles emuladas no
equivalen a probar teléfonos físicos ni a una auditoría externa.

Los informes `PRIVATE_*`, V8 y PWA anteriores conservan los resultados de sus
respectivas versiones. El control de Sites de la versión 10 es histórico;
la versión 11 autoriza con sus propias sesiones. No publiques `public/` como
sitio estático para esta versión: omitirías la protección del Worker.
