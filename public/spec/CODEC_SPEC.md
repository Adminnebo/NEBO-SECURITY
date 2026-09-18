# ASTRA pixel-permutation transport codec, version 1

This specifies the reversible transport layer. The separate
`ALGORITHM_SPECIFICATION.md` describes construction of the document, target,
and content-aware artwork. The transport codec accepts any pair of RGB images
having the same dimensions and the exact same multiset of pixel values.

## Inputs and scope

Each image is an H by W array of three unsigned 8-bit channels in R, G, B order.
N = W * H. Pixel identity is its original row-major coordinate:
`i = y * W + x`, with x increasing left to right and y top to bottom. A single
pixel is the unit of transport. There is no block approximation, resampling,
color conversion, quantization, color replacement, or pixel deletion in this
layer. This implementation limits N to 100,000,000 for resource control.

The original and artwork input files must use the canonical PNG profile below.
The target artwork, original PDF, source document, and JPEG reference are not
decoder inputs. The token contains integer ranks, checksums, dimensions, and
algorithm identifiers. It contains no RGB color samples, target image, PNG
archive, or compressed copy of the original file. Coordinate ranks still carry
substantial information about the original arrangement; this is not a claim
of a constant-size or secret reconstruction key.

## Exact canonical bijection

For a pixel v = (R,G,B), define `c(v) = (R << 16) | (G << 8) | B`.
Order each image's pixel indices by increasing `(c(pixel), flat_index)`.
Equivalent implementation: stable ascending unsigned RGB-code sort of the
row-major flattened array.

Let S be the sorted list of original indices; A the sorted list of artwork
indices. Define R, the inverse of S, by `R[S[k]] = k` for k from 0 to N-1.
The transport token stores R in original row-major order. It does not store A;
A is computed from the received artwork alone.

The forward permutation is:

```text
P(i) = A[R[i]]
artwork[P(i)] = original[i]
```

The inverse can be expressed as `P_inverse[A[k]] = S[k]`, or implemented
without explicitly building P_inverse:

```text
reconstructed[i] = artwork[A[R[i]]]
```

Because S and A are permutations of 0 through N-1, P is bijective. Each input
coordinate maps to exactly one output coordinate, and every output coordinate
is used exactly once. Before generating a token, the encoder compares the two
complete sorted RGB-code arrays for equality. Their equality establishes that
the permutation transfers each original value without changing it.

Identical RGB pixels are visually indistinguishable, but coordinates are still
given unique identities. The stable ordering supplies one precise canonical
bijection among all possible pairings of equal-valued pixels. That canonical
pairing need not be the provisional pairing used by the artwork optimizer;
it produces exactly the same artwork because each such substitution has the
same RGB value.

## Rank payload coding

Initialize previous = 0. For i from 0 to N-1:

1. Let delta = R[i] - previous; then set previous = R[i].
2. Zigzag-map delta to an unsigned integer u:
   `u = 2 * delta` for delta >= 0, otherwise `u = -2 * delta - 1`.
3. Write u as minimal unsigned LEB128: low 7 bits per byte, least-significant
   group first, with bit 7 set on every byte except the last. Zero is `00`.

Concatenate these N encodings. There is no array header or padding. Compress
this byte stream as one zlib stream (RFC 1950, DEFLATE payload). The reference
encoder calls `zlib.compress(raw, level=9)` with default window/strategy. Any
conforming zlib decoder is sufficient. The compressed stream must terminate
exactly: extra streams or trailing bytes are invalid.

Encode the compressed bytes using Base85 with this exact 85-character alphabet:

```text
0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~
```

This is Python `base64.b85encode`, using the RFC 1924 alphabet, without padding,
wrapping, or whitespace. Process each four-byte group as a big-endian integer
and write five base-85 digits, most significant first. For a final group of
one to three bytes, append zero bytes for encoding and retain respectively
two, three, or four output characters. Decode a short final character group
by adding alphabet character `~` to length five, then discard the padding
bytes. This is not Adobe Ascii85.

The decoded rank stream must contain exactly N integers, each in [0,N), and
its sorted contents must equal 0 through N-1. Non-minimal LEB128 encodings,
truncated integers, trailing integers, oversized integers, and duplicate or
missing ranks are rejected. Rank differences require at most five LEB128 bytes
under the stated pixel-count limit.

## Token envelope and checksum

`ASTRA_RECONSTRUCTION_TOKEN.txt` is ASCII JSON. The reference encoder writes
keys in ASCII lexicographic order, without spaces, then one LF newline.
Strings are JSON escaped; there are no floats. The exact field set is:

| Field | Value or meaning |
| --- | --- |
| format | `ASTRA-PXART-V1` |
| algorithm | `RGB-STABLE-RANK-DELTA-V1` |
| channels | `RGB` |
| indexing | `row-major:y*width+x` |
| color_order | `unsigned-24bit:(R<<16)\|(G<<8)\|B;ties=flat-index-ascending` |
| canonical_png | `RGB8-FILTER0-STORED-DEFLATE65535-V1` |
| rank_encoding | `signed-delta-zigzag-uleb128;previous=0` |
| compression | `zlib` |
| payload_encoding | `RFC1924-base85` |
| width, height, pixel_count | Positive integers; pixel_count = width * height |
| original_file_bytes, artwork_file_bytes | Exact PNG file sizes |
| original_file_sha256, artwork_file_sha256 | SHA-256 of exact PNG file bytes |
| original_pixels_sha256, artwork_pixels_sha256 | SHA-256 of row-major RGB bytes, without PNG encoding |
| rank_varint_bytes | Exact uncompressed LEB128-stream length |
| compressed_payload_bytes | Exact zlib-stream length |
| payload_sha256 | SHA-256 of compressed zlib-stream bytes |
| payload_data | Base85 ASCII encoding of the zlib stream |
| checksum_sha256 | Envelope checksum described below |

Hashes are 64 lowercase hexadecimal characters. To calculate checksum_sha256,
remove that one field, then serialize the remaining object as ASCII JSON with
keys lexicographically sorted and separators comma and colon, without any
additional spaces or newline, using ASCII JSON string escaping. Hash those
bytes. The final newline of the token is not part of this checksum. Reject
unknown/missing fields, duplicate keys, unsupported identifiers, invalid types,
invalid dimensions, hash mismatches, or inconsistent lengths.

The actual token size is the entire file's byte count, including JSON, all
hashes, Base85 overhead, and final LF. Compression savings come from the real
structure of the rank sequence, especially long runs of document background
pixels. The underlying payload describes N ranks. It is not generated by a
tiny seed, and there is no bound promising compactness for arbitrary images.

## Canonical PNG file bytes

PNG files can contain identical pixel arrays yet have different file hashes.
This profile makes the original and reconstructed PNGs byte-identical across
implementations:

1. Write the standard eight-byte PNG signature `89 50 4E 47 0D 0A 1A 0A`.
2. Write IHDR: width and height as four-byte big-endian integers; bit depth 8;
   color type 2 (RGB); compression 0; filter method 0; interlace 0.
3. Form the raw scanline bytes. Prepend one zero byte (PNG filter None) to each
   complete row of W RGB triplets. Concatenate rows from top to bottom.
4. Form a zlib stream starting with bytes `78 01`. Split the raw data into
   consecutive blocks of at most 65,535 bytes. Each block starts with byte `00`,
   except the final block starts `01` (BFINAL=1, BTYPE=00, zero padding). Append
   the two-byte little-endian block length LEN, its bitwise 16-bit complement
   NLEN, then the unchanged block data. All non-final blocks have LEN=65,535.
   Append the four-byte big-endian Adler-32 of the full raw scanline bytes.
5. Store the whole zlib stream in exactly one IDAT chunk.
6. Write an empty IEND chunk. Do not write any other chunks or trailing bytes.

Each chunk consists of four-byte big-endian data length, four-byte ASCII type,
data, and the four-byte big-endian standard PNG CRC-32 over type plus data.
There is no timestamp, DPI, text, alpha, color-profile, or application metadata.
The PDF establishes physical Letter size. Rendering at 300 DPI gives an image
of 2550 by 3300 pixels. No lossy encoding is used.

Stored DEFLATE deliberately forgoes PNG compression to make exact file bytes
independent of zlib compression heuristics. At high resolution this increases
PNG disk size; it does not increase the number of pixels or alter any values.

## Decoder procedure and integrity checks

1. Parse and validate the token envelope and checksum.
2. Decode Base85, verify compressed length/hash, inflate zlib with the declared
   uncompressed length as a strict limit, then validate all N ranks.
3. Verify artwork file length/hash, RGB dimensions, and raw-pixel hash.
4. Compute A by stable unsigned RGB sort of the artwork coordinates.
5. Produce `O[i] = artwork[A[R[i]]]` for every i.
6. Verify O's raw-pixel SHA-256 against original_pixels_sha256.
7. Generate canonical PNG bytes and verify their length and SHA-256 against
   original_file_bytes and original_file_sha256.
8. Only after all checks succeed, write the output PNG.

These checks detect corruption; they are not digital signatures and do not
authenticate the sender. Anyone who edits both images and token can recompute
ordinary checksums. This proof of concept does not claim encryption, secrecy,
tamper-proof storage, or authenticity of document contents.

## Commands and Python API

```powershell
python encoder.py --original ORIGINAL_DOCUMENT.png --artwork TRANSFORMED_PIXEL_ARTWORK.png --token ASTRA_RECONSTRUCTION_TOKEN.txt
python decoder.py --artwork TRANSFORMED_PIXEL_ARTWORK.png --token ASTRA_RECONSTRUCTION_TOKEN.txt --output RECONSTRUCTED_DOCUMENT.png
```

`codec.py` exposes:

```python
canonical_png_bytes(rgb_uint8_array) -> bytes
write_canonical_png(path, rgb_uint8_array) -> None
read_rgb_png(path) -> numpy.ndarray
stable_rgb_order(rgb_uint8_array) -> numpy.ndarray
load_token(path) -> (token_dict, ranks_int64_array)
encode(original_path, artwork_path, token_path) -> statistics_dict
decode(artwork_path, token_path, output_path) -> statistics_dict
```

Encoder and decoder need Python, NumPy, and Pillow. PNG output is written by
the specified custom writer; Pillow is used only to read RGB PNGs. NumPy's
stable sort implements the exact integer ordering specified above. All image
and coordinate outputs are deterministic. Exact token byte reproducibility is
guaranteed for the recorded Python/zlib runtime; different conforming zlib
compressors may produce different compressed bytes encoding identical ranks.
That does not change reconstruction or require that compressor at decode time.
The complete algorithm, integer coordinate stream, and canonical PNG profile
are portable without access to the original file or original encoder process.
