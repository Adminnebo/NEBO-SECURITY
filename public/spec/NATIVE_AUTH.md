# Acceso con usuario y contraseña de NEBO — versión 11

La pantalla `/login` está disponible para cualquier visitante. Entrar en la
aplicación requiere una cuenta creada por el administrador. No hay registro
público ni hace falta una cuenta de ChatGPT. Esta versión sustituye la barrera
de identidad de Sites de la versión 10 por autenticación propia en el servidor;
la audiencia pública del alojamiento permite alcanzar el login, no autoriza
por sí sola el acceso a la aplicación.

## Dar acceso a otra persona

1. Entra con tu cuenta administradora y abre **Mi cuenta**.
2. En **Personas con acceso**, indica un usuario, nombre y contraseña inicial.
   Puedes pulsar **Generar contraseña** y después **Crear usuario**.
3. Pulsa **Copiar enlace, usuario y contraseña** y comparte esos datos con la
   persona. NEBO no envía invitaciones ni correos automáticamente.
4. La persona abre el enlace y entra con ese usuario y contraseña. Puede cambiar
   su contraseña en **Mi cuenta**; al hacerlo se cierran sus sesiones anteriores.

Los nuevos usuarios tienen el rol `user`: pueden crear y abrir envíos, pero no
crear, listar ni modificar otras cuentas. El administrador puede desactivar
una cuenta, volver a activarla o establecer una nueva contraseña. Desactivar
o restablecer la contraseña revoca todas sus sesiones; reactivarla no recupera
las cookies anteriores. La cuenta administradora no puede desactivarse ni
restablecerse mediante los endpoints destinados a usuarios ordinarios.

**La contraseña de cuenta y la clave de un envío son distintas.** La primera
permite entrar en NEBO. La segunda descifra un PNG concreto y continúa fuera
del PNG/token. Cambiar la contraseña de cuenta no descifra mensajes, no cambia
sus claves y no recupera una clave de envío perdida.

## Contraseñas, sesiones y protección de solicitudes

Las contraseñas se almacenan como un hash scrypt con `N=32768`, `r=8`, `p=3`,
sal aleatoria de 16 bytes y resultado de 32 bytes. No se guardan en texto claro.
Estos parámetros corresponden a una de las combinaciones publicadas por
[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
La implementación acepta entre 12 y 128 caracteres y admite Unicode, con un
límite adicional de 1024 bytes UTF-8. No aplica normalización a la contraseña.

La cookie `__Host-nebo_session` contiene 32 bytes aleatorios codificados en
base64url y usa `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` y ocho horas de
vigencia. D1 almacena únicamente SHA-256 del identificador de sesión, junto al
usuario, fecha de expiración y token CSRF. Cada petición privada comprueba que
la sesión siga vigente y la cuenta siga habilitada. Cerrar sesión elimina esa
sesión; cambiar contraseña elimina todas las sesiones de la cuenta.

Las operaciones de cambio requieren `Origin` exactamente igual al de la app y
un token CSRF de la sesión. El login también comprueba `Origin`. Las entradas
JSON están limitadas a 16 KiB y las consultas SQL usan parámetros enlazados.
Los errores de login no distinguen usuario inexistente, desactivado o contraseña
incorrecta. Las respuestas del Worker usan `no-store`, CSP y otras cabeceras
de protección; no se guarda una decisión de autenticación en localStorage.

Los intentos de login se reservan en D1 antes de verificar la contraseña:
máximo 10 por usuario y 30 por IP por ventana fija de 15 minutos. El contador
incluye intentos correctos y erróneos. Se almacena el hash SHA-256 de la IP,
no su valor literal. Los contadores persisten entre reinicios del Worker.
Un exceso devuelve 429 y `Retry-After`; también puede limitar temporalmente
a varias personas que compartan una IP.

## Servidor y recursos privados

`worker/index.js` autoriza documentos, scripts y API privados antes de servirlos.
`worker/auth.js` implementa cuentas, hashes, sesiones y administración.
`public/access.js` valida `/api/auth/session` antes de cargar la app y vuelve a
comprobarla durante su uso. Si pierde acceso, cierra el trabajo en memoria.
Esta comprobación del cliente complementa al servidor; no lo sustituye.

`package_site_worker.py` incrusta HTML y código privados en un módulo del
Worker. No los copia al directorio de activos estáticos. Así, un router que
sirva archivos estáticos antes del Worker no encuentra una copia pública de
`index.html`, `app.js`, `account.js` o del manifest. El login se sirve desde ese
módulo mediante una excepción explícita. Los archivos de presentación del
login, imágenes genéricas y bibliotecas comunes pueden ser públicos y no
contienen sesiones, contraseñas ni mensajes. Véase el orden de enrutamiento en
[Cloudflare Static Assets](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

D1 conserva las cuentas y sesiones entre publicaciones. Las operaciones de
cambio de contraseña y revocación usan lotes transaccionales. Una comprobación
adicional impide emitir una sesión cuando la contraseña se restableció durante
su verificación. Si falla la base de datos o falta configuración, el Worker
devuelve 503 y no entrega por defecto los recursos de la aplicación.

El service worker envía las solicitudes a la red sin guardar la aplicación para
uso offline. Necesita internet para comprobar el acceso. La instalación móvil
permite abrirla desde un icono en modo independiente cuando el navegador lo
admite; no evita el login ni elimina la existencia de la URL.

## Datos del servidor y del dispositivo

El servidor de acceso guarda identificadores de usuario, nombres, roles,
estados, fechas, hashes de contraseña, sesiones, tokens CSRF y contadores de
intentos. Las contraseñas se transmiten por HTTPS al crear o verificar una
cuenta, pero no se almacenan en texto claro. Los archivos, fotos, notas de voz,
ubicaciones, PNG y claves de los envíos se procesan en el navegador; las API
de autenticación no reciben esos contenidos.

`public/account-storage.js` asigna bases IndexedDB distintas a las cuentas
ordinarias para organizar sus identidades de recepción y contactos. El único
administrador conserva las bases anteriores del mismo origen para no perder
las identidades existentes. Cerrar sesión no elimina esas bases.

Esta separación organiza la interfaz: no aísla datos frente a quien controle
el navegador, sus herramientas de desarrollo o el sistema operativo. IndexedDB
pertenece al origen y al perfil del navegador. No hay recuperación remota de
una identidad privada borrada ni garantía de custodia en hardware.

## Bootstrap y desarrollo

El Worker necesita un enlace D1 `DB` y el secreto `NEBO_BOOTSTRAP_ADMIN_JSON`:

```json
{"username":"nombre-admin","displayName":"Administrador","passwordHash":"<hash scrypt calculado previamente>"}
```

El helper `hashPassword` exportado por `worker/auth.js` calcula el hash. No
incluyas la contraseña ni el secreto del entorno en Git, en los activos del
cliente o en informes de pruebas. `.dev.vars` es solo configuración local.
El arranque crea las tablas si faltan y usa un marcador persistente para crear
el primer administrador una sola vez. Un cambio del secreto después no cambia
su contraseña ni recrea una cuenta borrada.

Para desarrollo, genera `worker/site-assets.js` con
`python package_site_worker.py --dev-assets` y ejecuta Wrangler con
`wrangler.local.jsonc`. Prueba por HTTPS para reproducir las cookies seguras y
el service worker. Servir `public/` mediante un servidor estático no reproduce
ni protege esta arquitectura. El empaquetado de publicación usa archivos del
commit y no incorpora `.dev.vars`, bases locales ni credenciales de prueba.

## Pruebas y límites

- `NATIVE_AUTH_BACKEND_REPORT.json`: 22 comprobaciones con los módulos reales,
  SQLite transaccional mediante un adaptador D1 y el scrypt real de Node.
- `NATIVE_AUTH_BROWSER_REPORT.json`: ocho recorridos con navegador real sobre
  el Worker y D1 locales: login, roles, CSRF, revocación y gestión de cuentas.
- Los informes de flujo del envío comprueban la recuperación del PNG con su
  clave; cada informe identifica el entorno utilizado.

Son pruebas funcionales y de controles concretos, no una auditoría externa ni
una certificación empresarial. No se han añadido MFA, recuperación por correo
ni una garantía de protección de un dispositivo comprometido. Las copias de
versiones públicas descargadas anteriormente no pueden revocarse a distancia.
Los documentos e informes de versión 10 describen su antigua barrera de Sites,
no el acceso con usuarios de esta versión.
