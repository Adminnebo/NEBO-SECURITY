# Seguridad de ASTRA: modo privado V2

El modo privado cifra el archivo completo y el token antes de entregarlos. La
imagen visible es una portada elegida por el usuario: los datos cifrados se
transportan dentro de los bits de sus canales RGB. Es un formato diferente de
la permutación clásica ASTRA-MSG-V1, que permanece disponible sin cifrado.

## Modelo de amenaza

Se busca proteger el contenido de un archivo frente a una persona que obtiene
el PNG y el token, pero no la clave secreta ni la clave privada del receptor.
También se rechazan alteraciones del token o la obra. El emisor y el receptor
deben usar una aplicación y dispositivos confiables.

El sistema no oculta la existencia del mensaje. La portada, dimensiones del
PNG, longitud de los archivos y modo de cifrado son visibles. Elegir una imagen
confidencial como portada revela visualmente esa imagen. La portada nunca debe
usarse como si fuese una vista previa protegida del documento.

## Controles implementados

1. **Contenido y token autenticados.** AES-256-GCM con etiquetas de 128 bits,
   claves distintas para el contenido y el token, y parámetros públicos
   autenticados. La criptografía procede de Web Crypto; no se implementan los
   algoritmos AES, SHA o ECDH manualmente en JavaScript.
2. **Claves independientes del paquete.** En modo de clave secreta, 32 bytes
   aleatorios generados criptográficamente; HKDF-SHA-256 separa los usos. La clave
   secreta no se incluye en el PNG, token, URL, registro ni almacenamiento local.
   Descargarla es una acción explícita. Debe guardarse y compartirse aparte.
3. **Destinatario verificado.** El modo opcional de identidad usa ECDH P-256 con
   una clave efímera del emisor. El remitente importa la identidad pública y
   confirma su huella por otro canal. Una huella que viene en el mismo archivo
   público comprueba consistencia, pero no identifica a la persona por sí sola.
4. **Aplicación y almacenamiento de claves.** La identidad privada se crea no
   exportable y se guarda como CryptoKey en IndexedDB del navegador. La clave
   pública es lo único que exporta la función de compartir identidad. La página
   emplea CSP, recursos locales y renderizado de texto mediante textContent.
5. **Exposición y transporte limitados.** Procesamiento local; la aplicación no
   envía documentos o secretos a su alojamiento. Se publica por HTTPS. Nombres,
   tipo de archivo y hash del original están dentro del contenido cifrado. Los
   archivos públicos usan nombres genéricos en el modo privado. No hay nube de
   mensajes ni copias automáticas de documentos o secretos.
6. **Pruebas y mantenimiento.** Pruebas positivas y negativas, comparación exacta
   de bytes y SHA-256, comprobación independiente de primitivas y formato,
   validación de tamaños antes de asignar memoria, rechazo de formatos extraños
   y documentación versionada. Los informes describen lo ejecutado; no son una
   certificación ni una auditoría externa profesional.

## Límites que no desaparecen por añadir cifrado

- Una página manipulada, extensión maliciosa o dispositivo comprometido puede
  capturar el archivo o usar las claves mientras la aplicación está abierta.
  Una CryptoKey no exportable no garantiza almacenamiento en hardware y no
  impide que código malicioso del mismo origen solicite operaciones con ella.
- La identidad privada no tiene respaldo exportable. Borrar los datos del sitio,
  eliminar la identidad o perder el perfil del navegador puede impedir abrir
  mensajes dirigidos a esa identidad. Para una prueba portable sin ese vínculo,
  se ofrece el modo de clave secreta guardada por separado.
- La clave ECDH permanente del receptor no aporta por sí sola secreto hacia
  adelante. No se implementa Double Ratchet ni se promete resistencia poscuántica.
- Cifrar para un destinatario no certifica la identidad de quien envió el mensaje.
  No hay firma digital del remitente ni garantía contra reenvíos de un paquete
  válido. Son propiedades distintas de detectar alteraciones del contenido.
- La aplicación no puede impedir que un destinatario copie el archivo abierto,
  ni revocar una clave o paquete que otra persona ya posee. No hay caducidad
  criptográfica de archivos portátiles sin un servicio externo.
- Las claves se manejan en memoria mientras se usan. Se liberan referencias y
  recursos cuando es posible, pero JavaScript no garantiza borrado seguro de RAM,
  portapapeles, descargas o copias del sistema operativo.
- La recuperación exacta no depende de la portada original ni de la red una vez
  cargada la aplicación. Sí depende del secreto correcto o de la identidad
  privada adecuada. El PNG debe enviarse como archivo, sin recomprimir ni editar.

## Diferencia con la prueba de permutación

En V2, la portada aporta colores públicos y algunos bits se modifican para llevar
el archivo cifrado. No conserva el multiconjunto de los píxeles del documento
legible. El modo clásico conserva su matriz original exactamente y continúa
identificado como no cifrado. No se presenta la esteganografía como cifrado:
la confidencialidad depende de AES-GCM y de la protección de las claves.

La selección 2K/4K fija las dimensiones del PNG entregado. Si la imagen de portada
tiene menos resolución, se remuestrea y la interfaz lo informa: aumentar el
número de píxeles no inventa detalle óptico. Los estilos locales modifican la
portada; las sugerencias generadas con IA son recursos incluidos, no un servicio
de generación de IA que reciba archivos del usuario.

## Referencias técnicas

- Web Crypto: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- AES-GCM: https://csrc.nist.gov/pubs/sp/800/38/d/final
- HKDF: https://www.rfc-editor.org/rfc/rfc5869
- Gestión de claves: https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html
- Modelo de amenazas: https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html

Antes de adoptar esta aplicación para información de alta sensibilidad, hace
falta una revisión externa del diseño, implementación y despliegue. No se afirma
haber realizado esa revisión ni haber configurado protección física del equipo.
