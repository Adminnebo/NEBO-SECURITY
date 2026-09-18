# ASTRA web — executed browser validation

Result: **PASS**. 20 checks completed in 24.438 seconds.

Application tested: http://127.0.0.1:8770

Browser: Microsoft Edge controlled through Playwright. The sender and receiver used separate browser contexts, with separate JavaScript state and workers. The receiving context never received the original file or target landscape.

After the static page and worker had loaded, all subsequent network requests were intercepted and aborted. This tests reconstruction after loading the application, not first-time loading without internet access. It is an isolated browser-session test, not a claim that a physical device in another location was used.

Worker test network attempts after cutoff: **0**.

Actual recipient interface tested: **True**.

Recipient interface network attempts after cutoff: **0**.

The real receiving form was exercised by selecting artwork and token files, clicking reconstruction, and downloading the restored original. Every downloaded byte and Unicode filename was checked.

## Executed checks

| Check | Outcome |
|---|---|
| Python→offline browser: png_alpha | PASS |
| Browser→Python: png_alpha | PASS |
| Independent offline browser sessions: png_alpha | PASS |
| Repeated browser encoding: artwork and token file bytes | PASS |
| Python→offline browser: pdf_two_pages | PASS |
| Browser→Python: pdf_two_pages | PASS |
| Independent offline browser sessions: pdf_two_pages | PASS |
| Python→offline browser: wav | PASS |
| Browser→Python: wav | PASS |
| Independent offline browser sessions: wav | PASS |
| Python→offline browser: text_utf8 | PASS |
| Browser→Python: text_utf8 | PASS |
| Independent offline browser sessions: text_utf8 | PASS |
| Changed PNG pixel | PASS — corrupt input rejected |
| Stale token checksum | PASS — corrupt input rejected |
| Duplicate ranks with valid checksums | PASS — corrupt input rejected |
| Actual offline recipient UI + original download: png_alpha | PASS |
| Actual offline recipient UI + original download: pdf_two_pages | PASS |
| Actual offline recipient UI + original download: wav | PASS |
| Actual offline recipient UI + original download: text_utf8 | PASS |

## Exact source fixtures

| File | Bytes | SHA-256 |
|---|---:|---|
| Montaña_café_🗻.png | 2,938 | `29155928dfdf7c37ac25217617ce921d282854449fb6a9ca63a3c18edfe98901` |
| contrato_dos_páginas.pdf | 915 | `04a6d53f68b69a7c0792f18fe5253a0169c4156fc345e19af12fd3af78c58e52` |
| nota_voz.wav | 8,044 | `f2f64e29bb147cc4c2cb7dfd1282cd2bdc3202bad8d4e891dc5d14283d7206d9` |
| carta_ñ_签名_🏔.txt | 80 | `a6de8317f35d020e3bd4fb092fab951b593884609288fbe35065bbc501e89b3e` |

The PNG contains real alpha and Unicode metadata; the PDF has two Letter pages; the WAV contains valid PCM audio; the text contains UTF-8 accents, Chinese, emoji, and mixed newline sequences.

## Integrity and compatibility

Python-generated ASTRA-MSG-V1 artwork/token pairs were decoded by the browser worker. Browser-generated pairs were independently decoded by the existing Python implementation and by the separate receiving browser. All restored original files matched byte-for-byte and by SHA-256. Unicode filenames exercise Python's ASCII-escaped canonical JSON checksum convention, including UTF-16 surrogate pairs for emoji.

For browser encoding, the audit independently rebuilt the composite source from the supplied preview RGB, original file bytes, and zero padding. It verified the exact source pixel SHA-256 and the complete sorted RGB multiset against the produced artwork. No sampling or tolerance was used. Repeating browser encoding produced identical artwork and token bytes.

Corruption checks changed a real artwork pixel, modified a token without updating its checksum, and created duplicate ranks while correctly recomputing all checksums. Every case was rejected.

Python was used as an external test driver and compatibility oracle. Browser conversion and reconstruction used the JavaScript worker, with no Python codec backend and no network access after the cutoff.

The reversible matrix is explicitly preview RGB + complete encoded original-file bytes + zero padding. This allows exact recovery of PDF, alpha/metadata-bearing image, text, and audio files; it is an extension of the earlier rendered-document-only pixel proof of concept.

## Reproduce

```powershell
python tests/audit_web.py --base-url http://127.0.0.1:8770 --reuse-fixtures --ui
```

The first run can omit `--reuse-fixtures` to regenerate all Python transport fixtures. The browser checks were executed on Edge; other browsers and physical devices were not part of this audit.
