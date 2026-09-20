/* Capacity planning only. Original attachment bytes are never resized. */
const EDGES = [1024, 1280, 1536, 2048, 2560, 3072, 3840, 4096];
const FORMATS = new Set(['auto', 'landscape', 'portrait', 'square']);
function dimensions(edge, format) {
  return format === 'square' ? [edge, edge] : format === 'portrait' ? [Math.round(edge * 2 / 3), edge] : [edge, Math.round(edge * 2 / 3)];
}
function candidate(edge, format, bytes) {
  const [width, height] = dimensions(edge, format);
  const bits = Math.max(1, Math.ceil(bytes * 8 / (width * height * 3)));
  const rawBytes = (width * 3 + 1) * height;
  return { width, height, format, bits, capacity: Math.floor(width * height * 3 * 4 / 8),
    // Stored DEFLATE upper bound, PNG framing and maximum embedded token.
    maxPngBytes: rawBytes + Math.ceil(rawBytes / 65535) * 5 + 6 + 57 + 16400 };
}
export function planCover({ ciphertextBytes = 0, format = 'auto', resolution = 'auto' } = {}) {
  if (!Number.isSafeInteger(ciphertextBytes) || ciphertextBytes < 0 || !FORMATS.has(format)) throw new Error('No se pudo calcular el tamaño de la portada.');
  const formats = format === 'auto' ? ['landscape', 'square'] : [format];
  const automatic = resolution === 'auto';
  const edge = Number(resolution);
  if (!automatic && (!Number.isInteger(edge) || edge < 256 || edge > 4096)) throw new Error('La resolución elegida no es válida.');
  const candidates = (automatic ? EDGES : [edge]).flatMap(size => formats.map(shape => candidate(size, shape, ciphertextBytes)));
  // Prefer the familiar landscape when it fits at up to two bits/channel.
  // Dense packages may use three/four bits; no channel ever exceeds four.
  let selected = candidates.find(value => value.bits <= 2);
  if (!selected) selected = candidates.find(value => value.bits <= 3);
  if (!selected) selected = candidates.find(value => value.bits <= 4);
  if (!selected) {
    const error = new Error('El contenido no cabe en esta portada. Usa formato y tamaño automáticos o Cuadrado de 4096 px.');
    error.code = 'CAPACITY'; throw error;
  }
  return { ...selected, automatic, ciphertextBytes };
}
