# NEBO AI - SECURITY v12.0.0: PostgreSQL y Railway

Publicar la versión anterior de `main` como archivos estáticos no mostraba el
login. Esta versión incluye un servidor Node.js que protege tanto las rutas
de la aplicación como sus recursos, y guarda cuentas y sesiones en PostgreSQL.
Una visita sin sesión redirige a `/login`; un administrador entra en `/account`
para crear, desactivar y restablecer usuarios.

## Cambios

- PostgreSQL mediante `pg`, consultas parametrizadas y pool limitado.
- Creación inicial del esquema y administrador dentro de una transacción,
  con bloqueo compartido entre instancias del servidor.
- Coordinación entre inicio de sesión y cambios de contraseña/desactivación
  mediante bloqueos de fila. Los cambios invalidan las sesiones activas.
- Servidor HTTP Node.js 24 preparado para el proxy HTTPS de Railway,
  origen público configurado, límite de cuerpo de 16 KiB y cierre ordenado.
- Recursos privados entregados después de verificar la sesión; rechazo de
  rutas ambiguas, enlaces simbólicos y accesos fuera del directorio de recursos.
- Healthcheck `/healthz` conectado a PostgreSQL, Dockerfile sin secretos de
  construcción y generador local de credenciales del primer administrador.
- El cifrado de los envíos, el PNG portable y sus claves conservan su formato.
  Los archivos originales no se guardan en PostgreSQL.

## Validación

Las pruebas usan un PostgreSQL 17.11 real por TCP en loopback, con esquemas
aislados. Los informes son específicos de esta versión:

- `tests/POSTGRES_BACKEND_REPORT.json`: autenticación, persistencia,
  inicialización concurrente, permisos, límites y carreras entre login y
  restablecimiento/desactivación.
- `tests/POSTGRES_HTTP_REPORT.json`: servidor real, rutas privadas, cabeceras,
  cuerpos de petición, reinicio y disponibilidad de la base.
- `tests/POSTGRES_BROWSER_REPORT.json`: navegador Edge con login, administración,
  separación de cuentas y recuperación del PNG en otro contexto de navegador.
- `tests/V12_D1_REGRESSION_REPORT.json`: compatibilidad con el backend anterior.

Resultado: **74 comprobaciones aprobadas**: 22 de backend PostgreSQL, 12 de
HTTP, 18 de navegador (8 de acceso, 4 de PNG, 6 de separación de cuentas) y
22 de regresión D1. El PNG se abrió en un contexto de navegador independiente
usando únicamente la imagen y su clave; el contenido recuperado coincidió.

También se verificaron una instalación limpia con dependencias exclusivamente
de producción y la generación de recursos usando solo Node. El generador de
credenciales conserva archivos existentes y no imprime contraseñas.

Estas pruebas son locales. No equivalen a un despliegue de Railway verificado,
a una prueba en teléfonos físicos ni a una auditoría de seguridad independiente.
El Dockerfile se revisó y se reprodujeron instalación y compilación; no se
ejecutó un contenedor Docker en esta máquina.

## Despliegue y datos existentes

Selecciona la rama `main` en Railway (también disponible como
`version-12-postgresql-railway`) y configura las
variables de [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md). El dominio necesita
el servidor y la base, además de los archivos del cliente.

La base D1 anterior permanece independiente. Las cuentas existentes no se
copian automáticamente a PostgreSQL. Esta versión no modifica ese despliegue,
ni elimina la rama `version-11-usuarios-nebo` o su etiqueta `v11.0.0`.
