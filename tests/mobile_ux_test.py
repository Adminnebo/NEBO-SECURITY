"""Real mobile sender/receiver UX checks; uses existing production crypto paths.

Run only after the mobile interface is ready:
    python tests/mobile_ux_test.py --base-url http://127.0.0.1:8772
    python tests/mobile_ux_test.py --base-url https://... --label public

Generated recovery secrets and private keys are never written to this report.
The only persisted images are screenshots with secret fields still masked.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "MOBILE_UX_REPORT.json"
SHOTS = ROOT / "tests" / "mobile-ui"
EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PHONE_SIZES = [(360, 800), (390, 844), (430, 932)]
SHARE_STUB = """(() => {
  // Capture an attempted native share locally; never open a real share sheet
  // or send files to another application or recipient during this test.
  Object.defineProperty(navigator, 'canShare', {configurable:true,
    value: data => Array.isArray(data?.files) && data.files.length === 2});
  Object.defineProperty(navigator, 'share', {configurable:true,
    value: async data => { window.__mobileShareFiles = data.files;
      window.__mobileShareCalls = (window.__mobileShareCalls || 0) + 1; }});
})();"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def download(page, selector):
    with page.expect_download(timeout=60000) as event:
        page.locator(selector).click()
    item = event.value
    return Path(item.path()).read_bytes(), item.suggested_filename


def ready(page, base_url, receiving=False):
    url = base_url.rstrip("/") + ("/?modo=recibir" if receiving else "/")
    response = page.goto(url, wait_until="networkidle", timeout=60000)
    assert response is not None and response.status == 200, "App did not return HTTP 200"
    page.locator('body[data-worker-ready="true"]').wait_for(state="attached", timeout=45000)
    page.locator("#mobileDock").wait_for(state="attached", timeout=15000)


def step(page, expected):
    page.locator(f'body[data-mobile-step="{expected}"]').wait_for(state="attached", timeout=15000)


def view(page, expected):
    page.locator(f'body[data-view="{expected}"]').wait_for(state="attached", timeout=15000)


def wait_result(page, mode, previous_href=None):
    deadline = time.monotonic() + 180
    selector = "#downloadArt" if mode == "sender" else "#downloadRestored"
    while time.monotonic() < deadline:
        error = page.locator(f"#{mode}Error")
        if error.is_visible() and error.inner_text().strip():
            raise AssertionError(error.inner_text())
        if page.locator(f"#{mode}Result").is_visible():
            href = page.locator(selector).get_attribute("href")
            if href and href != previous_href:
                return
        time.sleep(.1)
    raise AssertionError(f"{mode} did not complete in 180 seconds")


GEOMETRY = """() => {
  const shown = element => {
    const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
  };
  const label = node => node.id ? '#' + node.id : node.tagName.toLowerCase() + ' ' + (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 55);
  const targets = [...document.querySelectorAll('button:not(:disabled),a.button,select,summary,label.button')]
    .filter(shown).map(node => {const rect=node.getBoundingClientRect();return {target:label(node),width:+rect.width.toFixed(2),height:+rect.height.toFixed(2)}});
  const inputs = [...document.querySelectorAll('textarea,select,input[type=text],input[type=password],input:not([type])')]
    .filter(shown).map(node => ({target:label(node),font_size:parseFloat(getComputedStyle(node).fontSize)}));
  return {viewport_width:innerWidth,document_width:document.documentElement.scrollWidth,
    overflow:document.documentElement.scrollWidth>innerWidth+1,targets,inputs};
}"""


def geometry(page, mobile=True):
    measured = page.evaluate(GEOMETRY)
    assert not measured["overflow"], f"Horizontal overflow: {measured}"
    if mobile:
        undersized = [item for item in measured["targets"] if item["width"] < 43.5 or item["height"] < 43.5]
        small_inputs = [item for item in measured["inputs"] if item["font_size"] < 16]
        assert not undersized, "Touch targets below 44px: " + json.dumps(undersized, ensure_ascii=True)
        assert not small_inputs, "Input fonts below 16px: " + json.dumps(small_inputs, ensure_ascii=True)
    return {
        "viewport_width": measured["viewport_width"],
        "document_width": measured["document_width"],
        "overflow": measured["overflow"],
        "visible_touch_targets": len(measured["targets"]),
        "minimum_touch_width": min((item["width"] for item in measured["targets"]), default=None),
        "minimum_touch_height": min((item["height"] for item in measured["targets"]), default=None),
        "minimum_input_font": min((item["font_size"] for item in measured["inputs"]), default=None),
    }


def screenshot(page, label, width, stage):
    path = SHOTS / f"{label}_{width}_{stage}.png"
    page.screenshot(path=str(path), full_page=True)
    return path.relative_to(ROOT).as_posix()


def visible_error_above_dock(page):
    error = page.locator("#receiverError")
    error.wait_for(state="visible", timeout=60000)
    # An error must be shown by the UI, without the test scrolling to reveal it.
    # Allow the app's own smooth scroll to finish before checking its position.
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        box, dock = error.bounding_box(), page.locator("#mobileDock").bounding_box()
        if box and dock and box["y"] >= -1 and box["y"] + box["height"] <= dock["y"] + 1:
            return True
        time.sleep(.1)
    assert box and dock, "Missing error or mobile action dock"
    assert box["y"] >= -1 and box["y"] + box["height"] <= dock["y"] + 1, (
        f"Error is outside the visible region or behind the action dock: error={box}, dock={dock}"
    )
    return True


def run(args):
    SHOTS.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    checks, browser_errors = [], []
    report = {"status": "RUNNING", "base_url": args.base_url, "label": args.label,
              "browser": "Microsoft Edge / Chromium", "checks": checks,
              "browser_errors": browser_errors, "secrets_in_report": False}

    def passed(name, **detail):
        checks.append({"name": name, "passed": True, **detail})
        print("PASS " + name, flush=True)

    def observe(page, scope):
        page.on("pageerror", lambda error: browser_errors.append({"scope": scope, "type": "pageerror", "message": str(error)}))
        page.on("console", lambda message: browser_errors.append({"scope": scope, "type": "console", "message": message.text}) if message.type == "error" else None)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=EDGE, headless=True)
            for width, height in PHONE_SIZES:
                context = browser.new_context(viewport={"width": width, "height": height},
                                              is_mobile=True, has_touch=True, device_scale_factor=1,
                                              accept_downloads=True)
                context.add_init_script(SHARE_STUB)
                page = context.new_page(); observe(page, f"sender-{width}")
                ready(page, args.base_url); view(page, "sender"); step(page, 0)
                assert page.locator("#mobileDock").is_visible()
                assert page.locator("#mobileAction").is_disabled(), "Next action should require a file or selected text"
                metrics0 = geometry(page)
                screenshot(page, args.label, width, "01_archivo")
                if width == 390:
                    text = "Mensaje móvil ASTRA: café, montaña y mar.\nSegunda línea; texto UTF-8 exacto."
                    source = text.encode("utf-8"); name = "mensaje-nebo.txt"
                    page.locator("#textButton").click(); page.locator("#textInput").fill(text); page.locator("#useText").click()
                    assert page.locator("#textInput").input_value() == text
                    flow = "typed_text"
                else:
                    source = f"Archivo móvil de prueba ({width}px).\nConserva los acentos: áéíóú.\n".encode("utf-8")
                    name = f"nota-móvil-{width}.txt"
                    page.locator("#sourceFile").set_input_files({"name": name, "mimeType": "text/plain", "buffer": source})
                    flow = "file_upload"
                assert name in page.locator("#selectedFile").inner_text()
                page.locator("#mobileAction").click(); step(page, 1)
                assert page.locator("#coverControls").is_visible(), "Cover step should show its design controls"
                page.locator('[data-cover="coast"]').click()
                page.locator("#coverFormat").select_option("square")
                page.locator("#mobileBack").click(); step(page, 0)
                assert name in page.locator("#selectedFile").inner_text(), "Back navigation lost the selected file"
                if width == 390:
                    assert page.locator("#textInput").input_value() == text, "Back navigation lost text draft"
                # Switch sender/receiver tabs and return without dropping the draft.
                page.locator("#mobileReceiveTab").click(); view(page, "receiver")
                page.locator("#mobileSendTab").click(); view(page, "sender"); step(page, 0)
                assert name in page.locator("#selectedFile").inner_text()
                page.locator("#mobileAction").click(); step(page, 1)
                assert page.locator("#coverFormat").input_value() == "square"
                assert page.locator('[data-cover="coast"]').get_attribute("aria-pressed") == "true"
                # Use the default 2K horizontal output for manageable, real downloads.
                page.locator("#coverFormat").select_option("landscape")
                metrics1 = geometry(page)
                screenshot(page, args.label, width, "02_portada")
                page.locator("#mobileAction").click(); wait_result(page, "sender"); step(page, 2)
                page.locator("#artworkImage").evaluate("image => image.decode()")
                assert page.locator("#downloadArt").is_visible()
                metrics2 = geometry(page)
                screenshot(page, args.label, width, "03_resultado")
                artwork, artwork_name = download(page, "#downloadArt")
                token, token_name = download(page, "#downloadToken")
                key_file, key_name = download(page, "#downloadSecret")
                secret = page.locator("#recoverySecret").input_value()
                assert key_file.decode("ascii").strip() == secret and len(secret) == 43
                assert json.loads(token)["format"] == "ASTRA-SECURE-V2"
                assert artwork.startswith(b"\x89PNG\r\n\x1a\n")
                assert name not in artwork_name and name not in token_name
                page.locator("#sharePackage").click()
                sharing = page.evaluate("""async secret => {
                  const files = window.__mobileShareFiles || [];
                  const result = [];
                  for (const file of files) {
                    const bytes=await file.arrayBuffer();
                    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
                    const entry={name:file.name,type:file.type,bytes:file.size,sha256:hash};
                    if(file.name.endsWith('.txt')) {const text=await file.text();entry.token_format=JSON.parse(text).format;entry.contains_secret=text.includes(secret);}
                    result.push(entry);
                  }
                  return {calls:window.__mobileShareCalls || 0,files:result};
                }""", secret)
                assert sharing["calls"] == 1 and len(sharing["files"]) == 2
                assert {item["sha256"] for item in sharing["files"]} == {digest(artwork), digest(token)}
                shared_token = next(item for item in sharing["files"] if item["name"].endswith(".txt"))
                assert shared_token["token_format"] == "ASTRA-SECURE-V2" and not shared_token["contains_secret"]
                href = page.locator("#downloadArt").get_attribute("href")
                page.locator("#mobileReceiveTab").click(); view(page, "receiver")
                page.locator("#mobileSendTab").click(); view(page, "sender"); step(page, 2)
                assert page.locator("#downloadArt").get_attribute("href") == href, "Mode switch lost generated result"
                assert page.locator("#recoverySecret").input_value() == secret, "Mode switch lost the locally generated secret"
                passed(f"{width}px sender wizard, back navigation and three real downloads", input_method=flow,
                       steps=[metrics0, metrics1, metrics2], artwork_bytes=len(artwork), token_bytes=len(token),
                       separate_key_filename=key_name, original_sha256=digest(source),
                       state_preserved_across_navigation=True,
                       native_share={"tested_via_local_stub_only": True, "actual_external_sharing": False,
                                     "file_count": 2, "pair_hashes_match_downloads": True,
                                     "token_sent_as_txt": True, "secret_excluded": True})

                recipient_context = browser.new_context(viewport={"width": width, "height": height},
                    is_mobile=True, has_touch=True, device_scale_factor=1, accept_downloads=True)
                recipient = recipient_context.new_page(); observe(recipient, f"receiver-{width}")
                ready(recipient, args.base_url, receiving=True); view(recipient, "receiver")
                network_attempts = []
                recipient_context.route("**/*", lambda route: (network_attempts.append(route.request.url), route.abort())[1])
                recipient_context.set_offline(True)
                recipient.locator("#receivedArt").set_input_files({"name": artwork_name, "mimeType": "image/png", "buffer": artwork})
                recipient.locator("#receivedToken").set_input_files({"name": token_name, "mimeType": "application/json", "buffer": token})
                recipient.locator("#receivedSecret").wait_for(state="visible")
                # Explicitly exercise a visible validation failure at the central phone size.
                if width == 390:
                    recipient.locator("#receivedSecret").fill("A" * 43)
                    recipient.locator("#mobileAction").click()
                    visible_error_above_dock(recipient)
                    assert not recipient.locator("#receiverResult").is_visible()
                    screenshot(recipient, args.label, width, "04_error_visible")
                recipient.locator("#receivedSecretFile").set_input_files({"name": key_name, "mimeType": "text/plain", "buffer": key_file})
                # File.text() resolves asynchronously; poll without eval strings under CSP.
                deadline = time.monotonic() + 10
                while recipient.locator("#receivedSecret").input_value() != secret and time.monotonic() < deadline:
                    time.sleep(.05)
                assert recipient.locator("#receivedSecret").input_value() == secret
                receiving_metrics = geometry(recipient)
                recipient.locator("#mobileAction").click(); wait_result(recipient, "receiver")
                assert recipient.locator("#receiverPanel").evaluate("node => node.classList.contains('has-result')")
                result_metrics = geometry(recipient)
                screenshot(recipient, args.label, width, "05_original_recuperado")
                recovered, recovered_name = download(recipient, "#downloadRestored")
                assert recovered == source and recovered_name == name, "Recipient download differs from original bytes or filename"
                assert not network_attempts, f"Offline receiver attempted network access: {network_attempts}"
                passed(f"{width}px fresh offline receiver recovers exact original", original_sha256=digest(source),
                       reconstructed_sha256=digest(recovered), filename_preserved=True,
                       network_attempts=network_attempts, input_metrics=receiving_metrics,
                       result_metrics=result_metrics, wrong_key_error_visible=(width == 390))
                recipient_context.close(); context.close()

            desktop = browser.new_context(viewport={"width": 1440, "height": 1100}, accept_downloads=True)
            page = desktop.new_page(); observe(page, "desktop")
            ready(page, args.base_url)
            assert not page.locator("#mobileDock").is_visible(), "Mobile dock should not replace desktop controls"
            payload = b"ASTRA desktop regression. Exact file recovery remains available.\n"
            page.locator("#sourceFile").set_input_files({"name": "desktop-note.txt", "mimeType": "text/plain", "buffer": payload})
            assert page.locator("#encodeButton").is_visible()
            assert page.locator("#coverControls").is_visible()
            page.locator("#encodeButton").click(); wait_result(page, "sender")
            page.locator("#artworkImage").evaluate("image => image.decode()")
            page.evaluate("() => window.scrollTo(0, 0)")
            desktop_metrics = geometry(page, mobile=False)
            screenshot(page, args.label, 1440, "desktop_regression")
            passed("1440px desktop controls and real encoding remain functional", metrics=desktop_metrics)
            desktop.close(); browser.close()
        assert not browser_errors, "Browser errors: " + json.dumps(browser_errors, ensure_ascii=True)
        report["status"] = "PASS"
    except Exception as error:
        report["status"] = "FAIL"
        report["failure"] = str(error)
        raise
    finally:
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        report["screenshots"] = [path.relative_to(ROOT).as_posix() for path in sorted(SHOTS.glob(args.label + "_*.png"))]
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "checks": len(checks),
                          "report": str(REPORT), "seconds": report["elapsed_seconds"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8772")
    parser.add_argument("--label", default="local")
    run(parser.parse_args())
