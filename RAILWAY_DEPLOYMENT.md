# NEBO AI - SECURITY: PostgreSQL en Railway

La rama `main` ejecuta un servidor Node.js 24 y usa
PostgreSQL para usuarios, hashes de contraseña, sesiones y límites de acceso.
El contenido de los envíos y sus claves sigue procesándose en el navegador.

## 1. Seleccionar la versión y la base

1. Abre el servicio **NEBO-SECURITY** en tu proyecto de Railway.
2. En **Settings → Source**, selecciona `main`, que ya incluye el login y
   PostgreSQL. La rama `version-12-postgresql-railway` también conserva esta versión.
3. En el proyecto añade **New → Database → PostgreSQL**.
4. En **Variables** del servicio de la aplicación crea la referencia
   `DATABASE_URL=${{Postgres.DATABASE_URL}}`. Sustituye `Postgres` por el nombre
   real del servicio de base de datos si es distinto. Usa la conexión privada
   entre servicios; no hace falta publicar la base en Internet para la app.

## 2. Preparar el acceso administrador

En una copia local de esta rama:

```sh
npm ci
npm run admin:config
```

El comando genera dos archivos locales excluidos de Git y Docker:

- `NEBO-ADMIN-POSTGRES.key.txt`: usuario y contraseña inicial aleatoria.
- `NEBO-BOOTSTRAP-POSTGRES.key.txt`: JSON con usuario, nombre y hash scrypt.

Copia **todo el JSON** del segundo archivo como valor de
`NEBO_BOOTSTRAP_ADMIN_JSON` en Railway. El valor debe comenzar por `{`, sin
comillas exteriores añadidas por el panel. No pegues la contraseña sin hash
en `passwordHash`. El comando no sobrescribe credenciales existentes; para
otro conjunto usa `-- --output-dir RUTA`.

La configuración inicial solo crea el administrador en una base no
inicializada. Cambiar el secreto después no restablece su contraseña ni
recrea cuentas borradas. Los cambios de contraseña se realizan en **Mi cuenta**.
Esta versión requiere conservar un secreto de arranque válido al reiniciar.

## 3. Variables del servicio web

| Variable | Valor |
| --- | --- |
| `DATABASE_URL` | Referencia privada al servicio PostgreSQL. Obligatoria. |
| `NEBO_BOOTSTRAP_ADMIN_JSON` | JSON generado por `npm run admin:config`. Obligatoria. |
| `NODE_ENV` | `production` (también fijado en la imagen Docker). |
| `APP_ORIGIN` | URL pública exacta: `https://tu-dominio.example`, sin ruta. |
| `PORT` | Railway la proporciona; el servidor escucha en `0.0.0.0`. |
| `TRUST_PROXY` | `railway` cuando el servicio recibe tráfico mediante el proxy de Railway. |

Si no defines `APP_ORIGIN`, el servidor puede usar
`https://${RAILWAY_PUBLIC_DOMAIN}`. Para un dominio propio, define `APP_ORIGIN`
con ese dominio. No uses la URL del panel de Railway ni una dirección HTTP
en producción. Las validaciones de origen y las cookies requieren esta
configuración; no se confía en un encabezado Host arbitrario. Con
`TRUST_PROXY=railway`, el servidor valida `X-Real-IP` del proxy para separar
los límites de intentos por dirección y `X-Forwarded-Host` contra el dominio
configurado. Ignora `X-Forwarded-For` y cualquier `CF-Connecting-IP` enviado
por el cliente. Ese modo presupone que las peticiones pasan por el proxy de
confianza de Railway; para conexiones directas usa `none`, el valor predeterminado.

PostgreSQL usa las opciones TLS de `pg` y de la cadena de conexión. La aplicación
no desactiva la validación de certificados. Para una base externa configura
los certificados y el modo TLS indicados por su proveedor.

No se necesitan `DB`, `ASSETS`, claves de OpenAI, Supabase ni un secreto JWT.
Los dos bindings Cloudflare de la versión anterior son sustituidos por el
servidor Node y PostgreSQL. Los tokens de sesión son aleatorios y solo se
guarda su hash en la base.

## 4. Desplegar y comprobar

`railway.json` selecciona el `Dockerfile` incluido. La imagen instala las
dependencias de producción, genera los recursos privados y ejecuta
`node server/index.js`. No requiere Python ni Wrangler. Borra cualquier
comando anterior de inicio que lance un servidor estático y deja usar el
comando del Dockerfile. El healthcheck es `/healthz`.

La conexión y las tablas se comprueban antes de admitir tráfico. La creación
del esquema y del administrador se protege con una transacción y un bloqueo
de PostgreSQL para admitir arranques simultáneos. Un error de conexión impide
servir la aplicación privada; no se cae a un servidor de archivos estáticos.

Después de desplegar, abre la URL en una ventana privada:

1. `/` redirige a `/login`.
2. `/login` muestra usuario y contraseña.
3. `/api/auth/session` devuelve 401 antes del login.
4. Entra con los datos del archivo de administrador.
5. `/account` permite **Personas con acceso → Crear usuario**.
6. Reinicia el servicio y comprueba que el usuario creado sigue existiendo.

Una sesión ya iniciada abre directamente la aplicación. El healthcheck confirma
el servicio y su base de datos, pero no sustituye las pruebas del flujo de uso.

## Datos del despliegue anterior

La base PostgreSQL es independiente de la D1 existente. Este despliegue no
exporta ni modifica la base D1 de producción. Si necesitas conservar usuarios
anteriores, debes migrar sus registros y hashes de contraseña antes del cambio
definitivo. Las sesiones no deben copiarse: los usuarios deberán iniciar sesión
de nuevo. El cambio de dominio también separa el almacenamiento local del
navegador y las identidades guardadas en él.

## Desarrollo y pruebas

Node.js 24 y un PostgreSQL local o de pruebas son necesarios:

```sh
npm ci
# Copia .env.example a .env y configura la base y el secreto.
npm run dev
```

Usa `http://localhost:3000` con `NODE_ENV=development` solo para desarrollo.
Producción mantiene cookies `Secure`, `HttpOnly` y `SameSite=Lax` bajo HTTPS.
Los recursos del servidor siguen protegidos aunque se soliciten por ruta directa.

Las pruebas PostgreSQL usan `TEST_DATABASE_URL` y un esquema aislado creado para
esa ejecución. No uses una base de producción. Ejecuta `npm run build`,
`npm run test:postgres` y `npm run test:http`. Consulta los informes de la
versión para los casos y entornos realmente verificados.

`npm run test:browser` reutiliza los recorridos de login, PNG portable y
separación entre cuentas contra el servidor Node con PostgreSQL real. Requiere
Python, Playwright y Microsoft Edge en Windows; `PYTHON` permite indicar el
ejecutable. Crea un esquema aleatorio, utiliza credenciales sintéticas en
memoria y elimina su esquema al terminar. Esta prueba usa un origen localhost;
la publicación HTTPS de Railway debe comprobarse después del despliegue.

Fuentes: [PostgreSQL en Railway](https://docs.railway.com/databases/postgresql),
[referencias de variables](https://docs.railway.com/guides/tanstack-start#add-a-postgres-database),
[healthchecks](https://docs.railway.com/deployments/healthchecks),
[transacciones de node-postgres](https://node-postgres.com/features/transactions).
