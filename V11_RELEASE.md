# NEBO: usuarios y contraseñas propios

Aplicación 11, publicada como versión Sites 12 desde
`e95d509a2ce12e29753e063a131db2cdca51a117`, en la rama
`version-11-usuarios-nebo`. Las versiones anteriores no se reemplazaron en GitHub.

El administrador entra en `/account`, crea un usuario y copia enlace, usuario y
contraseña para entregarlos a la persona. No se requiere ChatGPT ni correo para
entrar. No hay registro público. Cada usuario puede cambiar su contraseña; el
administrador puede restablecerla o desactivar su cuenta.

La página de login está abierta. El Worker exige una sesión real para entregar
la aplicación y sus módulos privados. Esos recursos están embebidos en el
servidor y no se publican en el directorio estático, incluso si el alojamiento
resolviera assets antes de ejecutar el Worker. El alojamiento se cambió a
audiencia pública únicamente después de validar la protección propia.

Las cuentas, hashes scrypt, sesiones y contadores de intentos se guardan en D1.
Los mensajes, archivos y claves de recuperación continúan procesándose en el
navegador. La contraseña de una cuenta no sustituye la clave de un envío.

La credencial inicial del administrador se entregó en un archivo local fuera
del repositorio. El servidor conserva el hash de inicialización como secreto;
un marcador en D1 impide sobrescribir la contraseña al volver a desplegar.

## Pruebas ejecutadas

- Backend con SQLite y scrypt reales: **22/22**, incluyendo límite de intentos,
  concurrencia, CSRF, autorización, caducidad y revocación de sesiones.
- Navegador con Worker y D1 locales: **8/8**.
- Envío y recuperación locales tras login NEBO: **4/4**, bytes originales exactos.
- Cambio de cuenta en un mismo navegador: **6/6**; identidades y contactos
  separados, identidad del administrador conservada, 320 px sin desbordamiento.
- Publicación aún protegida por Sites durante transición: **8/8**.
- URL final, sin credencial de pruebas de Sites: **8/8**, login NEBO real,
  usuario independiente, bloqueo de recursos privados, administración y revocación.
- Envío y recuperación en URL final, con usuarios NEBO y sin acceso de pruebas:
  **4/4**, receptor nuevo con PNG y clave, bytes exactos y clave errónea rechazada.

Los informes están en `tests/NATIVE_*_REPORT.json`. Los usuarios sintéticos
creados por las pruebas quedan desactivados. Las pruebas de navegador fueron
automatizadas en Edge; no equivalen a una auditoría independiente ni a pruebas
en todos los modelos de teléfono.

Los almacenes locales se organizan por cuenta para el uso normal de la app.
No aíslan claves de alguien que controle físicamente el navegador o el sistema.
La especificación completa está en `public/spec/NATIVE_AUTH.md`.
