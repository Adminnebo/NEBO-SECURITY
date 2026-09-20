# Aplicación privada e instalación móvil

> Documento histórico de la versión 10 con login de ChatGPT. La versión 11
> usa cuentas NEBO: consulta [NATIVE_AUTH.md](NATIVE_AUTH.md).

La versión 10 usa el control de acceso del alojamiento Sites. El proyecto
existente pasó a audiencia `custom`, revisión 3, con el propietario como único
usuario autorizado. Las futuras invitaciones requieren elegir expresamente
qué personas tendrán acceso. La aplicación no implementa un registro público,
una contraseña compartida ni un inicio de sesión simulado en localStorage.

El alojamiento comprueba el acceso antes de entregar los recursos. La
comprobación de entrada del cliente usa un recurso propio servido por ese mismo
alojamiento; no constituye una API de identidad ni sustituye la autorización
del servidor. No se inventan endpoints del proveedor.

## Service worker y migración desde v9

`sw.js` v10 no precarga recursos ni escribe en Cache Storage. Todo GET del mismo
origen pasa a la red con `cache: 'no-store'`. Las respuestas 401, 403 y errores
del servidor se entregan sin sustituirlas por contenido almacenado. Las
redirecciones conservan el modo de la petición para permitir el inicio de
sesión del alojamiento. Ante un fallo de red, una navegación muestra únicamente
un aviso de conexión con estado 503, sin controles ni scripts de la app.

La activación elimina exclusivamente las cachés cuyo nombre cumple
`/^nebo-app-v\d+$/`. No modifica otras cachés ni IndexedDB. En particular,
conserva las claves privadas de recepción y los contactos locales.

La migración usa `skipWaiting` y `clients.claim` para que el transporte de las
pestañas abiertas adopte la política privada en cuanto se instale la versión
nueva. Se envía `NEBO_PRIVATE_MODE` con la versión 10 a los clientes. No se fuerza
una navegación que pueda destruir un envío en preparación.

Una pestaña anterior puede conservar JavaScript ya cargado hasta que se cierre.
Tampoco es posible retirar las copias de la versión pública ya descargadas y
guardadas sin conexión. Un navegador que nunca recibe la actualización puede
conservar su service worker antiguo; la protección de esta publicación no es
una revocación retroactiva de aquellos archivos.

## Instalación

El manifest usa `display: standalone`. Al abrir desde el icono instalado, un
navegador compatible presenta la app sin su barra habitual. Abrir el enlace en
una pestaña normal conserva la barra de direcciones. La instalación no evita
el inicio de sesión ni concede acceso a otras personas.

`installApp` e `installShortcut` comparten el flujo de instalación. Cuando no
hay diálogo nativo, se muestran instrucciones; en Safari iOS se usa Compartir
→ Añadir a pantalla de inicio. La app privada necesita internet al abrirse.

El enlace al manifest declara `crossorigin="use-credentials"` para incluir la
sesión al obtenerlo del alojamiento protegido, incluso siendo del mismo origen.
La configuración de presentación no sustituye la autorización del servidor.

## Validación

`python tests/private_sw_test.py` usa un servidor local con un control de acceso
simulado y Microsoft Edge real automatizado por Playwright. Comprueba la
migración del SW v9, conservación de identidad y cachés ajenas, navegación
denegada y sin conexión, redirección a login y ausencia de recursos privados
cacheados. El servidor de prueba no pretende reproducir la implementación
interna del proveedor; la configuración y las respuestas de producción se
comprueban por separado.
