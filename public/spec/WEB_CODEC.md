# Codec web ASTRA-MSG-V1

`codec-worker.js` implementa en JavaScript el formato transportable de la
aplicación Python. El receptor necesita **solamente la obra PNG y su token**.
El decodificador no consulta el original, una base de datos, el paisaje objetivo,
un modelo externo ni un servidor de conversión. El worker no hace peticiones
de red. Después de cargar la aplicación, puede reconstruir sin conexión.

## Información que se conserva

La matriz fuente se construye concatenando:

```text
RGB de una vista opcional || bytes exactos del archivo original || relleno cero
```

Los bytes se agrupan en tripletas RGB8. El render de una vista es opcional:
la recuperación conserva siempre el archivo completo, incluidas todas las
páginas del PDF, el contenedor de audio y los metadatos o alfa de una imagen.
Esta es la extensión `ASTRA-MSG-V1`; no afirma que una vista de la primera página
contenga por sí sola toda esa información.

Para Q bytes sin relleno: N = ceil(Q/3), W = ceil(sqrt(N×8.5/11)) y
H = ceil(N/W). Se añaden ceros hasta W×H×3 bytes y se usa la matriz H×W×3.
La vista guarda aparte su ancho, alto y hash. La combinación puede alterar
el orden visual de las filas de la vista; sus bytes se recuperan completos.

Límites aplicados antes de las asignaciones grandes: archivo 20 MiB, vista
2 millones de píxeles, matriz 12 millones y token JSON 48 MiB. La inflación
zlib detiene la lectura si excede la longitud esperada. No se interpreta el
archivo recuperado para restaurarlo: se devuelve como una secuencia de bytes.

## Asignación del paisaje

Cada píxel conserva sus tres valores RGB. Se ordenan los píxeles fuente por
`Y = (77R + 150G + 29B) >> 8`, con desempate por índice inicial. El worker usa
conteo de 256 niveles para obtener ese orden de forma estable.

El objetivo se recibe como matriz RGB o RGBA. Si tiene otras dimensiones,
se toma `tx=floor(x×target_width/W)`, `ty=floor(y×target_height/H)`: remuestreo
por vecino más cercano. Su alfa no se utiliza como canal de la matriz RGB.
El objetivo sirve únicamente para calcular posiciones, nunca para añadir
colores a la obra. Si no se proporciona, se calcula una guía montañosa con
operaciones enteras, igualmente usada solo para posiciones.

Para la luminancia objetivo Y, se calcula d=255−Y y un realce de bordes E
igual a la suma de diferencias absolutas con el píxel superior e izquierdo,
limitada a 48. Una matriz Bayer 32×32 define B. Las prioridades son:

```text
D = floor((d+8)^3 × (256+E) / 256) + 1
S = floor((2B+1) × 2^32 / D)
```

Se ordenan las coordenadas destino por `(S, índice_destino)` y se asigna cada
píxel fuente al destino correspondiente. Las dos listas son permutaciones
completas: ningún píxel se modifica, elimina o duplica. El resultado es una
aproximación perceptual determinada por los colores realmente disponibles.
No se afirma un mínimo global del error RGB ni reproducción fotográfica exacta.

## Token compatible con Python

El sobre `ASTRA-MSG-V1` tiene los mismos campos que Python: `format`, `filename`,
`mime_type`, `kind`, `render_scope`, `source_sha256`, `file_bytes`,
`payload_byte_offset`, `padding_bytes`, `preview`, `engine_token` y
`checksum_sha256`. La vista es nula o `{width,height,rgb_sha256}`.

El token interior `ASTRA-PXART-V1` usa `RGB-STABLE-RANK-DELTA-V1`. Para
`c=(R<<16)|(G<<8)|B`, se ordenan los índices fuente por `(c, índice_fuente)`.
R[i] es el rango de cada índice original en ese orden. El token almacena R,
con diferencias desde un valor previo inicial cero, zigzag, LEB128 mínimo,
compresión zlib y Base85 con el alfabeto de Python `base64.b85encode`:

```text
0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~
```

JavaScript obtiene R mediante tres pasadas estables radix de 8 bits, B/G/R.
El token contiene dimensiones, hashes y posiciones; no contiene muestras RGB,
los bytes originales ocultos ni una segunda copia del archivo.
Se informa el tamaño **completo y real** del token, incluyendo JSON y Base85.
No se promete que una semilla pequeña pueda representar cualquier permutación.

Los checksums se calculan sobre JSON compacto, con claves ordenadas, sin el
campo `checksum_sha256`. Todo carácter UTF-16 a partir de U+007F se escribe
como `\uXXXX` en minúsculas. Los caracteres fuera del plano básico usan dos
escapes de sustitutos UTF-16, exactamente como `json.dumps(ensure_ascii=True)`.
Se rechazan claves duplicadas, esquemas inesperados y hashes incorrectos.

## PNG canónico y reconstrucción

Los PNG usan el perfil original `RGB8-FILTER0-STORED-DEFLATE65535-V1`:
RGB8 sin alfa, filtro 0 en cada fila, cabecera zlib `78 01`, bloques DEFLATE
sin compresión de hasta 65 535 bytes, Adler-32, y únicamente IHDR/IDAT/IEND
con sus CRC-32. No hay metadatos adicionales. Esto permite verificar también
la igualdad de los **bytes completos** del PNG compuesto reconstruido.

El receptor analiza directamente estos bytes PNG. No usa canvas para leer
el contenido reversible y, por tanto, no depende de correcciones de color,
premultiplicación alfa ni conversiones del navegador.

Tras validar el token y los hashes de la obra, el receptor:

1. Infla y decodifica exactamente N rangos, cada uno entre 0 y N−1; una tabla
   de presencia comprueba que no se repitan y que la permutación sea biyectiva.
2. Ordena los valores RGB empaquetados de la obra como enteros sin signo.
3. Reconstruye cada píxel original con `sorted_artwork_RGB[R[i]]`.
4. Verifica el hash de los píxeles y del PNG canónico reconstruido.
5. Extrae los bytes en `[payload_byte_offset, payload_byte_offset+file_bytes)`.
6. Verifica su SHA-256, el de la vista opcional y que el relleno sea cero.

Ordenar valores RGB en el receptor equivale a ordenar coordenadas y leer sus
colores: los píxeles con igual valor son visualmente indistinguibles, mientras
que la validación de R garantiza una identidad coordenada única por entrada.

El emisor también compara los multiconjuntos RGB completos, cuenta directamente
los píxeles reconstruidos distintos y ejecuta el decodificador sobre la obra y
el token recién producidos. Solo entrega resultados con reconstrucción exacta.

## Reproducibilidad y diferencias entre motores

Con los mismos bytes originales, vista RGB, objetivo RGB y motor JavaScript,
la matriz, permutación, obra y token se reproducen exactamente. La prueba
automatizada ejecuta dos codificaciones y compara obra y token byte por byte.

La versión Python remuestrea su objetivo con Lanczos; este worker usa vecino
más cercano cuando debe cambiar su tamaño. Por ello pueden elegir distintas
posiciones si reciben objetivos de otro tamaño. Para comparar la asignación
entre motores se debe suministrar el mismo objetivo ya dimensionado.

El worker utiliza `CompressionStream('deflate')` para comprimir los rangos.
Python usa zlib nivel 9. Dos compresores válidos pueden producir tokens con
bytes o tamaños diferentes para el mismo flujo de rangos. Ambos tokens se
decodifican en ambos motores: la reconstrucción no necesita la biblioteca
que los comprimió. El PNG canónico se escribe de forma explícita y sí es
independiente de estas decisiones de compresión.

La interfaz puede usar canvas o un renderizador PDF para crear vistas y
objetivos. Esos renderizadores pueden variar entre navegadores. La promesa
de identidad del archivo completo se mantiene porque sus bytes originales
se conservan aparte dentro de la matriz, sin depender de esa representación.

Los hashes detectan corrupción y confirman identidad con el hash declarado.
No son firmas digitales ni cifrado: quien tenga la obra y el token puede
recuperar el archivo.

## Protocolo del worker

Crear `new Worker('./codec-worker.js', {type:'module'})`. El worker confirma
carga con `{type:'ready'}`. Las peticiones son:

```javascript
{id, action:'encode', file:ArrayBuffer, name, mime,
 preview?:{width,height,data:ArrayBuffer,channels?:3|4},
 target?:{width,height,data:ArrayBuffer,channels?:3|4}}

{id, action:'decode', artwork:ArrayBuffer, token:ArrayBuffer /* o texto JSON */}
```

Responde con progreso `{id,type:'progress',stage,percent,progress,message}`,
error `{id,type:'error',error,message}` o resultado `{id,type:'result',action,...}`.
La codificación entrega `artwork` y `token` como ArrayBuffers transferidos,
además de hashes, dimensiones, tamaño real del token y comprobaciones.
La decodificación entrega `file` como ArrayBuffer, `name`, `mime`, `sha256`
y `exact_file_recovery:true` después de todas las verificaciones.
