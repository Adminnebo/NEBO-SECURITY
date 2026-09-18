"""Independent cross-language browser transport audit.

Run with the static app serving on port 8770:
  python tests/audit_web.py --base-url http://127.0.0.1:8770
Prepare Python-generated fixtures only:
  python tests/audit_web.py --prepare-only

Uses Edge via Playwright, the legacy Python ASTRA-MSG-V1 implementation, and
two isolated browser contexts. No browser-side Python/API service is used.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib
import io
import json
import math
from pathlib import Path
import struct
import sys
import time
import wave
import zlib

from PIL import Image, ImageDraw, PngImagePlugin
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def b64(data):
    return base64.b64encode(data).decode("ascii")


def unb64(data):
    return base64.b64decode(data)


def ascii_json(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("ascii")


def resign(value):
    value = dict(value)
    value.pop("checksum_sha256", None)
    value["checksum_sha256"] = sha(ascii_json(value))
    return value


def png_fixture():
    image = Image.new("RGBA", (160, 216), (255, 255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle((9, 10, 150, 46), fill=(12, 42, 67, 255))
    draw.text((18, 20), "ASTRA / RGBA", fill=(255, 255, 255, 255))
    draw.text((13, 65), "Original bytes audit", fill=(16, 35, 54, 255))
    for y in range(120, 196):
        draw.line((12, y, 148, y), fill=(30, 120, 210, (y - 120) * 3))
    info = PngImagePlugin.PngInfo()
    info.add_itxt("Audit", "Metadata: café, montaña, 签名, 🗻")
    stream = io.BytesIO()
    image.save(stream, "PNG", pnginfo=info)
    return stream.getvalue()


def pdf_fixture():
    texts = [b"First page: ASTRA portable PDF audit", b"Second page: preserve every original PDF byte"]
    streams = [b"BT /F1 18 Tf 50 710 Td (" + value + b") Tj ET\n" for value in texts]
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for content in streams:
        objects.append(b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream")
    result = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(result))
        result += f"{index} 0 obj\n".encode() + value + b"\nendobj\n"
    xref = len(result)
    result += f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode()
    result += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    result += f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(result)


def wav_fixture():
    stream = io.BytesIO()
    samples = [round(11000 * math.sin(2 * math.pi * 523.25 * n / 16000)) for n in range(4000)]
    with wave.open(stream, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(struct.pack("<" + "h" * len(samples), *samples))
    return stream.getvalue()


def python_module(project):
    sys.path.insert(0, str(project))
    return importlib.import_module("payload")


def prepare_fixtures(payload):
    FIXTURES.mkdir(parents=True, exist_ok=True)
    fixtures = [
        ("png_alpha", "Montaña_café_🗻.png", "image/png", png_fixture()),
        ("pdf_two_pages", "contrato_dos_páginas.pdf", "application/pdf", pdf_fixture()),
        ("wav", "nota_voz.wav", "audio/wav", wav_fixture()),
        ("text_utf8", "carta_ñ_签名_🏔.txt", "text/plain; charset=utf-8",
         "Hola, montaña.\r\nImporte: € 127,40\n签名: 卢卡斯\nEmoji: 🏔️ 🌅\n\nFIN\n".encode("utf-8")),
    ]
    manifest = []
    for kind, filename, mime, original in fixtures:
        folder = FIXTURES / kind
        folder.mkdir(exist_ok=True)
        (folder / "original.bin").write_bytes(original)
        stats = payload.encode_message(original, filename, mime, folder)
        token = json.loads((folder / "token.json").read_bytes())
        record = {"kind": kind, "filename": filename, "mime": mime,
                  "original_bytes": len(original), "original_sha256": sha(original),
                  "pixel_count": stats["pixel_count"], "token_bytes": stats["token_bytes"],
                  "width": token["engine_token"]["width"], "height": token["engine_token"]["height"]}
        manifest.append(record)
        print(f"Prepared {kind}: {len(original)} source bytes, {stats['pixel_count']} pixels", flush=True)
    (FIXTURES / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


WORKER_BOOTSTRAP = r"""async () => {
  window.auditWorker = new Worker('/codec-worker.js', {type:'module'});
  window.auditCounter = 0;
  window.auditPending = new Map();
  window.auditWorker.onmessage = ({data}) => {
    if (data.type === 'progress' || (data.progress !== undefined && data.type !== 'result' && !data.result && !data.error && !data.artwork && !data.file)) return;
    const pending = window.auditPending.get(data.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    window.auditPending.delete(data.id);
    pending.resolve(data);
  };
  window.auditWorker.onerror = error => {
    for (const pending of window.auditPending.values()) { clearTimeout(pending.timer); pending.reject(new Error(error.message)); }
    window.auditPending.clear();
  };
  window.auditCall = input => new Promise((resolve,reject) => {
    const id = 'audit-' + (++window.auditCounter);
    const timer = setTimeout(()=>{window.auditPending.delete(id);reject(new Error('Worker timed out'));},120000);
    window.auditPending.set(id,{resolve,reject,timer});
    window.auditWorker.postMessage({...input,id});
  });
  const reply = await window.auditCall({action:'decode',artwork:new ArrayBuffer(0),token:'{}'});
  return {loaded:true, handshake:reply};
}"""


WORKER_CALL = r"""async input => {
  const from64 = value => Uint8Array.from(atob(value), c=>c.charCodeAt(0)).buffer;
  const to64 = value => {
    const bytes = new Uint8Array(value);
    let binary='';
    for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return btoa(binary);
  };
  for(const key of ['file','artwork','token']) if(input[key]!==undefined) input[key]=from64(input[key]);
  for(const key of ['preview','target']) if(input[key]) input[key].data=from64(input[key].data);
  const raw = await window.auditCall(input);
  const reply = raw.result || raw;
  const normalize = value => {
    if(value instanceof ArrayBuffer) return to64(value);
    if(ArrayBuffer.isView(value)) return to64(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength));
    if(Array.isArray(value)) return value.map(normalize);
    if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]));
    return value;
  };
  return normalize(reply);
}"""


def call(page, action, **kwargs):
    return page.evaluate(WORKER_CALL, {"action": action, **kwargs})


def assert_decoded(reply, original, filename):
    if reply.get("error") or "file" not in reply:
        raise AssertionError(f"Decoder failed: {reply}")
    recovered = unb64(reply["file"])
    assert recovered == original, "Recovered original bytes differ"
    assert sha(recovered) == sha(original)
    assert reply["name"] == filename, "Unicode filename was not preserved"
    return recovered


def bad_rank_token(token_bytes):
    token = json.loads(token_bytes)
    inner = dict(token["engine_token"])
    count = inner["pixel_count"]
    compressed = zlib.compress(bytes(count), level=9)
    inner.update(payload_data=base64.b85encode(compressed).decode("ascii"),
                 payload_sha256=sha(compressed), rank_varint_bytes=count,
                 compressed_payload_bytes=len(compressed))
    token["engine_token"] = resign(inner)
    return ascii_json(resign(token))


def audit_recipient_ui(browser, args, manifest, results):
    """Exercise actual file inputs, reconstruction button, and download link."""
    context = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1080})
    assert context.cookies() == []
    page = context.new_page()
    response = page.goto(args.base_url, wait_until="networkidle")
    assert response is not None and response.status == 200, "Anonymous recipient page load failed"
    page.wait_for_function("document.body.dataset.workerReady === 'true'", timeout=30000)
    blocked = []
    def no_network(route):
        blocked.append(route.request.url)
        route.abort("internetdisconnected")
    context.route("**/*", no_network)
    context.set_offline(True)
    page.locator("#receiverTab").click()
    for record in manifest:
        kind = record["kind"]
        folder = FIXTURES / kind
        original = (folder / "original.bin").read_bytes()
        page.locator("#receivedArt").set_input_files(str(folder / "artwork.png"))
        page.locator("#receivedToken").set_input_files(str(folder / "token.json"))
        page.locator("#decodeButton").click()
        page.wait_for_function("expected => document.querySelector('#receiverHash')?.textContent.includes(expected)",
                               arg=sha(original), timeout=120000)
        with page.expect_download(timeout=30000) as download_info:
            page.locator("#downloadRestored").click()
        download = download_info.value
        recovered = Path(download.path()).read_bytes()
        assert recovered == original, f"Actual UI download differs for {kind}"
        assert download.suggested_filename == record["filename"], "Actual UI lost Unicode filename"
        results.append({"test": f"Actual offline recipient UI + original download: {kind}",
                        "passed": True, "original_sha256": sha(recovered),
                        "download_filename": download.suggested_filename})
        print(f"PASS actual offline recipient UI {kind}", flush=True)
        if kind == "png_alpha":
            page.screenshot(path=str(ROOT / "tests" / "UI_OFFLINE_RECIPIENT.png"), full_page=True)
    context.close()
    return blocked


def write_report(report):
    report_path = ROOT / "WEB_VALIDATION_REPORT.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# ASTRA web — executed browser validation",
        "", f"Result: **{report['status']}**. {len(report['checks'])} checks completed in {report['seconds']} seconds.",
        "", f"Application tested: {report['base_url']}",
        "", "Browser: Microsoft Edge controlled through Playwright. The sender and receiver used separate browser contexts, with separate JavaScript state and workers. The receiving context never received the original file or target landscape.",
        "", "Each browser context started with empty cookies and no saved storage state. No credentials, account session, authorization headers, or authenticated browser profile were supplied. The application page returned HTTP 200 in these contexts.",
        "", "After the static page and worker had loaded, all subsequent network requests were intercepted and aborted. This tests reconstruction after loading the application, not first-time loading without internet access. It is an isolated browser-session test, not a claim that a physical device in another location was used.",
        "", f"Worker test network attempts after cutoff: **{len(report['post_cutoff_network_attempts'])}**.",
        "", f"Actual recipient interface tested: **{report['actual_recipient_ui_tested']}**.",
    ]
    if report["actual_recipient_ui_tested"]:
        lines.extend(["", f"Recipient interface network attempts after cutoff: **{len(report['recipient_ui_post_cutoff_network_attempts'])}**.",
                      "", "The real receiving form was exercised by selecting artwork and token files, clicking reconstruction, and downloading the restored original. Every downloaded byte and Unicode filename was checked."])
    lines.extend(["", "## Executed checks", "", "| Check | Outcome |", "|---|---|"])
    for check in report["checks"]:
        label = check["test"].replace("|", "\\|")
        result = "PASS — corrupt input rejected" if check.get("rejected") else "PASS"
        lines.append(f"| {label} | {result} |")
    lines.extend(["", "## Exact source fixtures", "", "| File | Bytes | SHA-256 |", "|---|---:|---|"])
    for fixture in report["fixtures"]:
        lines.append(f"| {fixture['filename']} | {fixture['original_bytes']:,} | `{fixture['original_sha256']}` |")
    lines.extend([
        "", "The PNG contains real alpha and Unicode metadata; the PDF has two Letter pages; the WAV contains valid PCM audio; the text contains UTF-8 accents, Chinese, emoji, and mixed newline sequences.",
        "", "## Integrity and compatibility", "",
        "Python-generated ASTRA-MSG-V1 artwork/token pairs were decoded by the browser worker. Browser-generated pairs were independently decoded by the existing Python implementation and by the separate receiving browser. All restored original files matched byte-for-byte and by SHA-256. Unicode filenames exercise Python's ASCII-escaped canonical JSON checksum convention, including UTF-16 surrogate pairs for emoji.",
        "", "For browser encoding, the audit independently rebuilt the composite source from the supplied preview RGB, original file bytes, and zero padding. It verified the exact source pixel SHA-256 and the complete sorted RGB multiset against the produced artwork. No sampling or tolerance was used. Repeating browser encoding produced identical artwork and token bytes.",
        "", "Corruption checks changed a real artwork pixel, modified a token without updating its checksum, and created duplicate ranks while correctly recomputing all checksums. Every case was rejected.",
        "", "Python was used as an external test driver and compatibility oracle. Browser conversion and reconstruction used the JavaScript worker, with no Python codec backend and no network access after the cutoff.",
        "", "The reversible matrix is explicitly preview RGB + complete encoded original-file bytes + zero padding. This allows exact recovery of PDF, alpha/metadata-bearing image, text, and audio files; it is an extension of the earlier rendered-document-only pixel proof of concept.",
        "", "## Reproduce", "", "```powershell",
        f"python tests/audit_web.py --base-url {report['base_url']} --reuse-fixtures" + (" --ui" if report["actual_recipient_ui_tested"] else ""),
        "```", "", "The first run can omit `--reuse-fixtures` to regenerate all Python transport fixtures. The browser checks were executed on Edge; other browsers and physical devices were not part of this audit.",
    ])
    (ROOT / "WEB_VALIDATION_REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def audit(args, payload, manifest):
    from playwright.sync_api import sync_playwright
    results = []
    started = time.monotonic()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(args.edge), headless=True,
                                            args=["--disable-gpu"])
        sender_context = browser.new_context()
        receiver_context = browser.new_context()
        assert sender_context.cookies() == [] and receiver_context.cookies() == []
        sender = sender_context.new_page()
        receiver = receiver_context.new_page()
        for page in (sender, receiver):
            response = page.goto(args.base_url, wait_until="networkidle")
            assert response is not None and response.status == 200, f"Anonymous app load failed: {response.status if response else 'no HTTP response'}"
            page.evaluate(WORKER_BOOTSTRAP)
        blocked = []
        def no_network(route):
            blocked.append(route.request.url)
            route.abort("internetdisconnected")
        receiver_context.route("**/*", no_network)
        sender_context.route("**/*", no_network)
        receiver_context.set_offline(True)
        sender_context.set_offline(True)

        for record in manifest:
            kind = record["kind"]
            folder = FIXTURES / kind
            original = (folder / "original.bin").read_bytes()
            art = (folder / "artwork.png").read_bytes()
            token = (folder / "token.json").read_bytes()
            reply = call(receiver, "decode", artwork=b64(art), token=b64(token))
            assert_decoded(reply, original, record["filename"])
            results.append({"test": f"Python→offline browser: {kind}", "passed": True,
                            "original_sha256": sha(original), "original_bytes": len(original)})
            print(f"PASS Python -> offline browser {kind}", flush=True)

            encode_input = {"file": b64(original), "name": record["filename"], "mime": record["mime"]}
            if (folder / "preview.png").exists():
                with Image.open(folder / "preview.png") as preview:
                    encode_input["preview"] = {"width": preview.width, "height": preview.height,
                                                "channels": 3, "data": b64(preview.convert("RGB").tobytes())}
            with Image.open(payload.ASSET) as master:
                target = master.convert("RGB").resize((record["width"], record["height"]), Image.Resampling.LANCZOS)
                encode_input["target"] = {"width": target.width, "height": target.height,
                                           "channels": 3, "data": b64(target.tobytes())}
            encoded = call(sender, "encode", **encode_input)
            if encoded.get("error") or "artwork" not in encoded or "token" not in encoded:
                raise AssertionError(f"Browser encode failed: {encoded}")
            js_art, js_token = unb64(encoded["artwork"]), unb64(encoded["token"])
            parsed_token = json.loads(js_token)
            preview_bytes = unb64(encode_input["preview"]["data"]) if "preview" in encode_input else b""
            composite_bytes = preview_bytes + original + bytes(parsed_token["padding_bytes"])
            assert sha(composite_bytes) == parsed_token["engine_token"]["original_pixels_sha256"], "Browser modified source composite"
            source_pixels = np.frombuffer(composite_bytes, dtype=np.uint8).reshape(-1, 3)
            with Image.open(io.BytesIO(js_art)) as artwork_image:
                assert artwork_image.mode == "RGB"
                art_pixels = np.asarray(artwork_image, dtype=np.uint8).reshape(-1, 3)
            def rgb_numbers(pixels):
                p = pixels.astype(np.uint32)
                return (p[:, 0] << 16) | (p[:, 1] << 8) | p[:, 2]
            assert np.array_equal(np.sort(rgb_numbers(source_pixels)), np.sort(rgb_numbers(art_pixels))), "Browser artwork did not conserve exact RGB multiset"
            (folder / "browser_artwork.png").write_bytes(js_art)
            (folder / "browser_token.json").write_bytes(js_token)
            recovered, metadata = payload.decode_message(js_art, js_token)
            assert recovered == original and metadata["filename"] == record["filename"]
            results.append({"test": f"Browser→Python: {kind}", "passed": True,
                            "original_sha256": sha(recovered), "token_bytes": len(js_token),
                            "independent_exact_rgb_multiset_equality": True,
                            "canonical_source_pixels_hash_matches": True,
                            "browser_artwork_matches_python_artwork": js_art == art})
            reply = call(receiver, "decode", artwork=b64(js_art), token=b64(js_token))
            assert_decoded(reply, original, record["filename"])
            results.append({"test": f"Independent offline browser sessions: {kind}", "passed": True})
            print(f"PASS browser -> Python and separate receiver {kind}", flush=True)
            if kind == "png_alpha":
                repeat = call(sender, "encode", **encode_input)
                assert unb64(repeat["artwork"]) == js_art and unb64(repeat["token"]) == js_token
                results.append({"test": "Repeated browser encoding: artwork and token file bytes", "passed": True})

        folder = FIXTURES / "png_alpha"
        artwork = (folder / "artwork.png").read_bytes()
        token = (folder / "token.json").read_bytes()
        with Image.open(io.BytesIO(artwork)) as original_image:
            changed = original_image.copy()
            pixel = changed.getpixel((0, 0))
            changed.putpixel((0, 0), ((pixel[0]+1) % 256, pixel[1], pixel[2]))
            output = io.BytesIO()
            changed.save(output, "PNG")
        corrupt = json.loads(token)
        corrupt["source_sha256"] = "0" * 64
        cases = [
            ("Changed PNG pixel", output.getvalue(), token),
            ("Stale token checksum", artwork, ascii_json(corrupt)),
            ("Duplicate ranks with valid checksums", artwork, bad_rank_token(token)),
        ]
        for label, art_bytes, key_bytes in cases:
            reply = call(receiver, "decode", artwork=b64(art_bytes), token=b64(key_bytes))
            if not reply.get("error") and reply.get("type") != "error":
                raise AssertionError(f"Corrupt input accepted: {label}: {reply}")
            results.append({"test": label, "passed": True, "rejected": True,
                            "reason": str(reply.get("error") or reply.get("message"))})
            print(f"PASS rejects {label}", flush=True)
        ui_blocked = audit_recipient_ui(browser, args, manifest, results) if args.ui else None
        browser.close()
    report = {"status": "PASS", "browser": "Microsoft Edge / Playwright", "base_url": args.base_url,
              "seconds": round(time.monotonic() - started, 3), "checks": results,
              "network_blocked_after_page_and_worker_load": True,
              "browser_context_offline_mode": True,
              "anonymous_fresh_contexts_without_saved_cookies_or_storage": True,
              "credentials_or_account_session_supplied": False,
              "post_cutoff_network_attempts": blocked,
              "actual_recipient_ui_tested": args.ui,
              "recipient_ui_post_cutoff_network_attempts": ui_blocked,
              "separate_sender_receiver_contexts": True,
              "decoder_received_only": ["artwork PNG bytes", "token bytes"],
              "fixtures": manifest}
    write_report(report)
    print(json.dumps({"status": report["status"], "checks": len(results), "seconds": report["seconds"],
                      "post_cutoff_network_attempts": len(blocked)}, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8770")
    parser.add_argument("--python-project", type=Path, default=ROOT.parent / "ASTRA_MENSAJERIA")
    parser.add_argument("--edge", type=Path, default=Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--reuse-fixtures", action="store_true")
    parser.add_argument("--ui", action="store_true", help="Also test the real receiving UI offline and downloaded source files")
    args = parser.parse_args()
    payload = python_module(args.python_project)
    manifest = (json.loads((FIXTURES / "manifest.json").read_text("utf-8"))
                if args.reuse_fixtures else prepare_fixtures(payload))
    if not args.prepare_only:
        audit(args, payload, manifest)


if __name__ == "__main__":
    main()
