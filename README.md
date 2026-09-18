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

En el teléfono, la interfaz guía el envío en tres pasos: **Archivo → Portada →
Compartir**. La barra inferior permite avanzar, volver y cambiar a **Abrir
recibido**. Las opciones adicionales están plegadas. El enlace es el mismo en
móvil y escritorio; no hace falta instalar una aplicación.

Si el navegador admite compartir archivos, aparece un botón para enviar el
PNG y el token con el menú del dispositivo. La clave secreta queda fuera de
esa selección. También siguen disponibles las descargas individuales.

1. Selecciona un PDF, imagen o audio; también puedes escribir texto o grabar voz.
2. Elige modo privado, una portada sugerida o propia, y la resolución. La
   portada queda visible: usa una imagen que puedas compartir.
3. Crea el envío. Se cifra el archivo y se verifica su recuperación antes de
   habilitar la descarga del PNG y del token cifrado.
4. Guarda la clave secreta generada. No está dentro del PNG ni del token.
   Compártela por un canal separado y protegido. Si la pierdes, no existe una
   clave maestra del servidor que permita recuperar el archivo.
5. Envía PNG + token junto con el enlace del receptor. En WhatsApp, adjunta el
   PNG como documento/archivo, sin recomprimir.
6. El receptor selecciona ambos archivos y aporta la clave secreta. Puede
   reconstruir sin red después de cargar la página y los motores.

## Identidad opcional del destinatario

El receptor crea una identidad en su navegador y exporta solo su clave pública.
El emisor la importa y verifica su huella por otro canal. La clave privada es
una CryptoKey no exportable guardada en IndexedDB y no viaja en el paquete.

No hay respaldo exportable de esa identidad privada. Borrar los datos del
sitio o perder el perfil puede impedir abrir mensajes dirigidos a ella. Para
la primera prueba portable, usa el modo de clave secreta guardada aparte.
No exportable no garantiza protección por hardware: código malicioso del
mismo origen o un equipo comprometido puede usar la clave mientras está abierta.

## Color, resolución y formato real

ASTRA-SECURE-V2 cifra el archivo y sus metadatos con AES-256-GCM. Los datos
cifrados se guardan dentro de los bits menos significativos de los canales RGB
de la portada. El token está cifrado y autentica los parámetros y el PNG completo.

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
En teléfonos conviene empezar con archivos pequeños. El PNG sin pérdidas puede
pesar mucho más que el original. La aplicación muestra el tamaño real del token.

## Implementación y pruebas

- `public/secure-worker.js`: cifrado, transporte RGB y recuperación V2.
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
python tests/secure_audit_ui.py --base-url http://127.0.0.1:8770
python tests/mobile_ux_test.py --base-url http://127.0.0.1:8770 --label local
```

Los scripts usan Microsoft Edge en Windows. `MOBILE_RELEASE.md` explica el
resultado de la interfaz móvil y el aviso CSP observado en el alojamiento
público. Los informes conservan los resultados reales, incluidos los avisos.
