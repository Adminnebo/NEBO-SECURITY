# NEBO privado · versión de aplicación 10

La nueva rama `version-10-acceso-privado` mantiene separado el acceso restringido
de la modalidad pública anterior. El proyecto de alojamiento conserva su URL y
usa la política `custom`, inicialmente solo para el propietario. El inicio de
sesión es el de ChatGPT proporcionado por Sites; no hay cuentas o contraseñas
propias de NEBO ni registro abierto.

La aplicación valida un recurso protegido del origen antes de importar el
editor y sus motores, antes de crear/abrir envíos y periódicamente al volver a
usar la ventana. Una respuesta 200 con un formulario HTML de login tampoco se
considera autorización. La autorización real corresponde al servidor: el JSON
de comprobación no es una credencial ni una API que identifique a un usuario.

El SW privado solicita la red sin caché y transmite las denegaciones sin volver
al HTML almacenado. Migra la caché pública v9 sin borrar identidades ni contactos
de IndexedDB. Al perder autorización, la sesión de trabajo se cierra y requiere
verificar de nuevo; puede ser necesario volver a seleccionar archivos en curso.

En móviles compatibles puede instalarse desde la cabecera o Ayuda. Se abre en
modo standalone desde su icono; en una pestaña web normal la URL continúa visible.
El manifest protegido se solicita con credenciales de sesión. No se cambió el
dominio: no se ha proporcionado uno propio y cambiar de origen también afecta
a las identidades no exportables que pertenecen al navegador/origen anterior.

## Pruebas

- `PRIVATE_ANONYMOUS_REPORT.json`: ocho rutas del alojamiento rechazaron acceso
  anónimo con HTTP 401, sin HTML ni JavaScript de NEBO expuestos.
- `PRIVATE_DEPLOYED_ANONYMOUS_REPORT.json`: se repitieron las ocho rutas después
  de publicar la versión 10; todas rechazaron acceso anónimo con HTTP 401.
- `PRIVATE_BOOTSTRAP_REPORT.json`: 12 casos de validación, entradas inválidas,
  autorización, nueva comprobación al operar y cierre tras revocación.
- `PRIVATE_SW_REPORT.json`: 15 casos de migración desde el SW público real,
  conservación de claves/contactos, denegación, redirección y arranque offline.
- `PRIVATE_USERFLOW_REPORT.json`: cuatro recorridos completos en navegador local,
  incluida recuperación exacta con PNG y clave, y contactos guardados.
- `PRIVATE_MANIFEST_REPORT.json`: cinco casos con sesión HttpOnly simulada;
  el manifiesto recibe la cookie, se analiza como standalone y el navegador
  informa cero errores de instalación. El control sin credenciales falla.
- `PRIVATE_DEPLOYED_OWNER_REPORT.json`: cuatro recorridos contra la URL real,
  con la credencial de pruebas del propietario solo en memoria; un receptor
  nuevo recuperó exactamente el original desde PNG y clave, rechazó una clave
  incorrecta y se verificó la persistencia de contactos.
- `PRIVATE_DEPLOYED_SOURCE_REPORT.json`: ocho recursos protegidos devolvieron
  HTTP 200 con acceso autorizado y coincidieron byte por byte con el código
  del commit publicado `9ab7809805b3ac2a31d4dce797424351110722b7`.
- `tests/ui-v10/`: gate y aplicación en 320, 390 y 1440 px; instalador y controles
  de cabecera de 44 px. Las pruebas no equivalen a uso en teléfonos físicos.

Las validaciones públicas autenticadas pueden usar la credencial de pruebas del
propietario ya proporcionada por Sites, solo en memoria y contra ese origen.
No equivalen a automatizar el inicio de sesión OAuth de una persona. Las pruebas
anónimas usan contextos nuevos sin credenciales de ningún tipo.
Chromium omite la cabecera de pruebas en la descarga inicial del SW: el ensayo
intercepta únicamente esa petición del mismo origen para añadirla. No se cambia
el comportamiento de producción, que recibe la cookie de una sesión real.

No es posible retirar copias anteriores que otra persona ya descargó o clonó.
La política protege esta publicación alojada, no revoca los archivos históricos.
Los originales, mensajes y claves de recuperación siguen procesándose localmente;
el alojamiento no recibe los archivos del envío.
