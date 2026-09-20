# Aplicación sin conexión y contactos públicos

> Documento histórico de la modalidad pública 9, conservada en la rama
> `version-9-png-token-integrado`. La modalidad privada 10 reemplaza la caché
> offline por validación en el alojamiento: véase [PRIVATE_ACCESS.md](PRIVATE_ACCESS.md).

`contact-store.js` ofrece `listContacts()`, `saveContact(name, publicBundle)` y
`removeContact(fingerprint)`. Cada contacto contiene exclusivamente `id`, `name`,
`publicBundle` y `createdAt`, en IndexedDB `nebo-public-contacts-v1`, almacén
`contacts`. La huella validada de la clave pública identifica el registro;
guardar esa misma clave actualiza su alias y conserva su fecha inicial.

Los alias admiten 1–60 caracteres Unicode, normalizados a NFC y sin caracteres
de control. Se validan la estructura pública, la huella SHA-256 y el punto P-256.
No se aceptan campos de clave privada. El límite de 50 contactos se aplica en
una transacción de lectura/escritura, también frente a escrituras concurrentes.
La base `astra-private-identities-v1` permanece separada y no se modifica al
guardar ni eliminar contactos. Un alias local no verifica la identidad de una
persona: la huella pública todavía debe comprobarse por un canal independiente.

## Instalación y uso sin conexión

`initInstallUI()` conecta `installApp`, `installStatus` y `offlineStatus` con la
instalación del navegador y registra `sw.js` en HTTPS o localhost. Cuando el
navegador no ofrece un diálogo programático, el botón muestra instrucciones
para su menú; en iOS indica Compartir → Añadir a pantalla de inicio.
No se afirma que una instalación se completó solo porque se pulsó el botón.

La caché `nebo-app-v9` contiene una lista explícita de 20 recursos estáticos:
HTML, CSS/tema/app versión 9, los dos motores, PNG portátil, planificación de
portada, identidad, contactos, bundle, instalación, manifest, logos existentes,
cuatro portadas y el PDF de ejemplo. Cada URL es exacta, incluida la consulta
`?v=9` de app, tema y CSS. No se cachean POST, otros orígenes, blobs, entradas de
usuarios, tokens, claves, archivos reconstruidos ni URLs con parámetros libres.

La instalación utiliza un lote atómico `Cache.addAll`: si falta un recurso
esencial, no queda una aplicación instalada a medias. Las navegaciones válidas
intentan la red durante hasta 3,5 segundos y recurren al HTML almacenado. Los
recursos estáticos conocidos usan primero su caché. El HTML de respaldo solo
se actualiza si referencia los scripts de esta versión, para conservar una
aplicación coherente al abrirla sin conexión.

No se emplean `skipWaiting` ni `clients.claim`. Una actualización espera a que
se cierren las páginas anteriores y no sustituye el motor durante una operación.
La activación elimina únicamente cachés antiguas con nombre `nebo-app-vN`;
no elimina IndexedDB ni cachés de otras aplicaciones. Debe incrementarse la
versión de caché y de los tres URLs versionados al cambiar la aplicación.

La apertura y recuperación no requieren el renderizador PDF. Los archivos PDF
recuperados se descargan mediante una tarjeta segura; sus bytes permanecen
exactos. El renderizador PDF del modo clásico no forma parte de la precarga:
crear una vista de PDF en ese modo puede necesitar conexión. Compartir mediante
otras aplicaciones y abrir mapas externos depende de esas aplicaciones y de
la conectividad disponible.

El manifest conserva el logo existente: SVG con `sizes: any` y PNG original
de **1834 × 1800**. No declara falsamente iconos PNG de 192 o 512 píxeles, ni
un icono maskable. La disponibilidad de instalación depende del navegador;
los resultados reales de su comprobación se registran en el informe de pruebas.

## Reproducción

Requiere Python, Playwright y Microsoft Edge. Con la aplicación servida:

```powershell
python tests/pwa_contacts_test.py --base-url http://127.0.0.1:8774
python tests/pwa_atomic_failure_test.py
```

La prueba principal utiliza un perfil temporal, valida contactos y cierra por
completo Edge. Después inicia otro proceso con el mismo perfil y sin red antes
de abrir la página: comprueba el arranque, ambas modalidades privadas, el par
clásico, la persistencia de contactos y la identidad no exportable. El perfil
de prueba se elimina al finalizar; las claves de prueba no se imprimen.

Los resultados se guardan en `tests/PWA_CONTACTS_REPORT.json` y
`tests/PWA_FAILURE_REPORT.json`. Este segundo informe confirma que un 503
deliberado en un recurso esencial impide la activación y deja cero entradas
parciales, conservando la caché anterior y una caché ajena.

Verificación local inicial: **12 comprobaciones aprobadas en 20,140 s**,
con reinicio completo de Edge y navegación inicial sin conexión. Cero errores
de ejecución. El navegador devolvió una lista vacía de errores de
instalabilidad; eso no equivale a haber instalado la aplicación en el sistema
operativo ni verifica otros navegadores o iOS.

La regresión con redirección canónica y caché v9 pasó en **5,875 s**: reinicio
completo sin red, respuesta 200, HTML idéntico byte por byte y ambos motores
listos. Véanse `tests/pwa_redirect_test.py` y `tests/PWA_REDIRECT_REPORT.json`.
