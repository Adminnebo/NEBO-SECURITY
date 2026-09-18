# ASTRA-MSG-V1: reversible messages

This app extends the earlier rendered-document pixel-permutation experiment.
The source matrix explicitly contains **preview pixels, original file bytes,
and zero padding**. It is not a claim that a preview alone preserves a PDF's
other pages, an image's original encoding, or an audio recording.

## Construction

1. Accept a nonempty file of at most 20 MiB. Supported inputs are text UTF-8,
   readable PDF, Pillow-supported image, and WAV/FLAC/OGG/MP3/WebM/M4A audio.
2. Render an optional RGB preview, limited to 2,000,000 pixels. PDF preview is
   page one at up to 120 DPI. Image previews can be resized and transparency
   displayed on white. Text previews show a bounded readable excerpt. These
   display choices do not modify the retained original file bytes. Audio uses
   no preview and requires no transcription or external service.
3. Concatenate `preview_RGB_bytes || exact_original_file_bytes || zero_padding`.
   The preview segment is empty for audio. Let Q be the combined segment length
   before padding, N = ceil(Q/3), W = ceil(sqrt(N * 8.5/11)), H = ceil(N/W).
   Pad to exactly W*H*3 bytes, then reshape to H by W by 3 unsigned 8-bit RGB.
   The combined matrix has at most 12,000,000 pixels. The original preview
   dimensions are stored separately because this composite reshape need not
   preserve its readable spatial layout.
4. Resize the supplied mountain target to W by H as an optimization guide.
   `engine.permute.assign` deterministically reorders the composite matrix's
   single pixels. No target pixels enter the artwork. The copied original
   engine implements integer luminance/edge-weighted ordered-screen priorities
   and stable row-major tie breaking.
5. `engine.codec.encode` verifies exact equality of the source/artwork pixel
   multisets and stores the reversible canonical coordinate ranks. Its source
   and artwork PNGs use the deterministic RGB8/filter0/stored-DEFLATE profile
   specified in `engine/CODEC_SPEC.md`.
6. Decode immediately and compare exact recovered file bytes with the input.
   Also reconstruct the RGB matrix and directly count mismatching pixels.
   Only verified results are written to the requested output directory.

## Transport package

`package.zip` has exactly three members: `artwork.png`, `token.json`, and
`LEEME.txt`. It contains no separate original file, hidden source PNG, target,
or encrypted/compressed backup. ZIP member timestamps are fixed to 1980-01-01
for reproducibility. `preview.png`, when generated for the app interface, is
not part of the transport package and is not required for reconstruction.

The token is sorted compact ASCII JSON, followed by LF. Its exact field set:

| Field | Meaning |
| --- | --- |
| format | `ASTRA-MSG-V1` |
| filename | Sanitized original filename |
| mime_type | Restored file's detected media type |
| kind | `text`, `image`, `pdf`, or `audio` |
| render_scope | Human-readable Spanish description of preview scope |
| source_sha256 | SHA-256 of exact original file bytes |
| file_bytes | Exact original file byte count |
| payload_byte_offset | Number of preview RGB bytes preceding the original file |
| padding_bytes | Zero bytes appended after the original file |
| preview | null, or `{width,height,rgb_sha256}` for the rendered preview |
| engine_token | Complete `ASTRA-PXART-V1` rank token described in engine/CODEC_SPEC.md |
| checksum_sha256 | SHA-256 of compact sorted ASCII JSON excluding this field |

The token stores no original data bytes or RGB samples. It necessarily carries
information about pixel arrangement. Its actual size is reported, and can be
substantial for arbitrary compressed inputs. There is no claim that a tiny
random seed represents all the coordinate mappings.

## Recovery

Given only artwork.png and token.json, validate envelope checksum, dimensions,
byte ranges and resource limits. Use the nested engine token to recover the
composite RGB matrix. Flatten to RGB bytes, then slice:

```text
original = reconstructed_rgb_bytes[payload_byte_offset : payload_byte_offset + file_bytes]
```

Verify SHA-256 equals source_sha256, verify preview hash if applicable, and
verify all trailing padding bytes are zero. This restores the original encoded
file byte-for-byte, including PDF pages beyond the preview, image alpha/EXIF/
metadata, and the exact audio container and samples. No source file, server
database, target image, external model, or original conversion process is
needed for reconstruction. The token format and algorithm code must be
available to the receiving implementation.

The public Python functions in payload.py are:

```python
encode_message(data: bytes, filename: str, mime_type: str, output_dir: Path) -> dict
decode_message(artwork_bytes: bytes, token_bytes: bytes) -> (bytes, dict)
decode_package(package_bytes: bytes) -> (bytes, dict)
```

The decoder never extracts arbitrary ZIP member paths. The package is limited
to 70 MiB both compressed and expanded, and token JSON to 48 MiB. Package names
are an exact allowlist; duplicate or encrypted members are rejected. Declared
matrix sizes and PNG dimensions are checked before image decoding. Tokens and
artworks are integrity checked; checksums are not signatures or encryption.

Run payload tests with:

```powershell
python -m unittest discover -s tests -p test_payload.py -v
```
