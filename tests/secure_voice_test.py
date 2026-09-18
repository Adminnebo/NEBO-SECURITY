"""Fake-microphone secure voice UI test with fresh offline recipients.

Owns only this test and SECURE_VOICE_REPORT.json. The microphone input is a
synthetic 440 Hz fixture; no real microphone is accessed or recorded.
"""
import argparse
import base64
import io
import json
from pathlib import Path
import struct
import tempfile
import time
import wave

from playwright.sync_api import sync_playwright
from test_voice_web import digest, download, synthetic_wav


ROOT = Path(__file__).resolve().parents[1]


def run(base_url):
    started = time.perf_counter()
    errors, recipients = [], []
    with tempfile.TemporaryDirectory(prefix="secure-voice-ui-", dir=ROOT / "tests") as temporary:
        scratch = Path(temporary).resolve()
        assert scratch.is_relative_to((ROOT / "tests").resolve())
        fake = scratch / "synthetic_microphone.wav"
        synthetic_wav(fake)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True, args=[
                "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
                "--use-file-for-fake-audio-capture=" + str(fake),
                "--autoplay-policy=no-user-gesture-required"])
            sender = browser.new_context(permissions=["microphone"], accept_downloads=True)
            page = sender.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(base_url, wait_until="networkidle")
            page.evaluate("() => window.ASTRA_READY")
            assert page.locator("#encodingMode").input_value() == "private"
            assert page.locator('input[name="accessMode"][value="secret"]').is_checked()
            page.locator("#recordButton").click()
            page.locator("#recording").wait_for(state="visible", timeout=10000)
            page.wait_for_timeout(1500)
            page.locator("#stopRecord").click()
            page.locator("#selectedFile audio").wait_for(state="visible")
            original = base64.b64decode(page.evaluate("""async () => {
                const buffer = await (await fetch(document.querySelector('#selectedFile audio').src)).arrayBuffer();
                const bytes = new Uint8Array(buffer); let string = '';
                for(let i=0;i<bytes.length;i+=32768) string += String.fromCharCode(...bytes.subarray(i,i+32768));
                return btoa(string);
            }"""))
            original_name = page.locator("#selectedFile strong").text_content()
            with wave.open(io.BytesIO(original), "rb") as wav:
                rate, channels, width, frames = wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getnframes()
                samples = [value[0] for value in struct.iter_unpack("<h", wav.readframes(frames))]
            nonzero = sum(value != 0 for value in samples)
            assert rate > 0 and channels == 1 and width == 2 and frames > rate // 2 and nonzero > 0
            original_hash = digest(original)
            page.locator("#encodeButton").click()
            page.locator("#senderResult").wait_for(state="visible", timeout=120000)
            page.locator("#secretResult").wait_for(state="visible")
            secret = page.locator("#recoverySecret").input_value()
            assert len(secret) == 43
            assert page.locator("#recoverySecret").get_attribute("type") == "password"
            art, token_path, key_path = (scratch / name for name in ("artwork.png", "token.json", "recovery.key.txt"))
            art_name = download(page, "#downloadArt", art)
            token_name = download(page, "#downloadToken", token_path)
            key_name = download(page, "#downloadSecret", key_path)
            assert key_path.read_text(encoding="ascii").strip() == secret
            raw_token = token_path.read_bytes()
            token = json.loads(raw_token)
            assert token["format"] == "ASTRA-SECURE-V2" and token["mode"] == "secret"
            assert secret.encode() not in raw_token
            assert original_hash.encode() not in raw_token
            assert original_name.encode() not in raw_token
            assert "encrypted_body" in token
            assert original_hash in page.locator("#senderHash").text_content()
            token_bytes, artwork_bytes, key_bytes = len(raw_token), art.stat().st_size, key_path.stat().st_size
            sender.close()

            for access in ("paste", "key_file_import"):
                recipient = browser.new_context(accept_downloads=True)
                received = recipient.new_page()
                received.on("pageerror", lambda error: errors.append(str(error)))
                received.goto(base_url + "/?modo=recibir", wait_until="networkidle")
                received.evaluate("() => window.ASTRA_READY")
                requests = []
                received.on("request", lambda request: requests.append(request.url)
                            if request.url.startswith(("http://", "https://")) else None)
                recipient.set_offline(True)
                received.locator("#receivedArt").set_input_files(art)
                received.locator("#receivedToken").set_input_files(token_path)
                received.locator("#receiverSecretFields").wait_for(state="visible")
                if access == "paste":
                    # The same pair is insufficient without the separate secret.
                    received.locator("#decodeButton").click()
                    received.locator("#receiverError").wait_for(state="visible")
                    assert "clave" in received.locator("#receiverError").text_content().lower()
                    assert not received.locator("#receiverResult").is_visible()
                    received.locator("#receivedSecret").fill(secret)
                else:
                    received.locator("#receivedSecretFile").set_input_files(key_path)
                    received.wait_for_function("document.querySelector('#receivedSecret').value.length === 43")
                    assert received.locator("#receivedSecret").input_value() == secret
                received.locator("#decodeButton").click()
                received.locator("#receiverResult").wait_for(state="visible", timeout=120000)
                output = scratch / (access + ".wav")
                restored_name = download(received, "#downloadRestored", output)
                restored = output.read_bytes()
                assert restored == original
                assert restored_name == original_name
                assert original_hash in received.locator("#receiverHash").text_content()
                assert received.locator("#restoredPreview audio").count() == 1
                assert not requests, requests
                recipients.append({"access": access, "byte_identical": True,
                                   "sha256": digest(restored), "separate_context": True,
                                   "offline_before_import": True, "http_requests_during_recovery": 0})
                recipient.close()
            browser.close()
    assert not errors, errors
    return {"status": "PASS", "url": base_url, "browser": "Microsoft Edge / Playwright",
            "microphone_source": "Synthetic 440 Hz WAV through Chromium fake-device flags; no real microphone",
            "default_mode": "ASTRA-SECURE-V2 / secret", "recording_wait_ms": 1500,
            "original_file_bytes": len(original), "sample_rate_hz": rate, "channels": channels,
            "bits_per_sample": width * 8, "frames": frames, "duration_seconds": frames / rate,
            "nonzero_samples": nonzero, "source_sha256": original_hash,
            "artwork_bytes": artwork_bytes, "token_bytes": token_bytes, "separate_key_file_bytes": key_bytes,
            "secret_characters": len(secret), "secret_saved_in_report": False,
            "secret_absent_from_token": True, "original_name_absent_from_token": True,
            "original_hash_absent_from_token": True, "missing_secret_blocked_in_ui": True,
            "download_names": {"artwork": art_name, "token": token_name, "separate_key": key_name},
            "recipients": recipients, "page_errors": errors,
            "seconds": round(time.perf_counter() - started, 3)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8770")
    args = parser.parse_args()
    report = run(args.base_url.rstrip("/"))
    (ROOT / "tests" / "SECURE_VOICE_REPORT.json").write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="ascii")
    print(json.dumps(report, indent=2, ensure_ascii=True))
