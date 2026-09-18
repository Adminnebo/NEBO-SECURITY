"""Exercise recording, downloads, and isolated offline voice recovery in Edge.

The microphone is a generated sine-wave fixture supplied through Chromium's
fake-device flags. This test never requests or records a real microphone.
"""
import argparse
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import struct
import tempfile
import time
import wave

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def synthetic_wav(path):
    rate = 48000
    pcm = b"".join(struct.pack("<h", round(0.35 * 32767 * math.sin(2 * math.pi * 440 * i / rate)))
                   for i in range(rate * 4))
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(pcm)


def download(page, selector, destination):
    with page.expect_download(timeout=30000) as event:
        page.locator(selector).click()
    event.value.save_as(destination)
    return event.value.suggested_filename


def run(base_url):
    started = time.perf_counter()
    failures = []
    with tempfile.TemporaryDirectory(prefix="voice-ui-test-", dir=ROOT / "tests") as temporary:
        scratch = Path(temporary).resolve()
        assert scratch.is_relative_to((ROOT / "tests").resolve())
        fake_audio = scratch / "synthetic_microphone.wav"
        synthetic_wav(fake_audio)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True, args=[
                "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
                "--use-file-for-fake-audio-capture=" + str(fake_audio),
                "--autoplay-policy=no-user-gesture-required"])
            sender = browser.new_context(permissions=["microphone"], accept_downloads=True)
            page = sender.new_page()
            page.on("pageerror", lambda error: failures.append(str(error)))
            page.goto(base_url, wait_until="networkidle")
            page.wait_for_function("document.body.dataset.workerReady === 'true'")
            page.locator("#recordButton").click()
            page.locator("#recording").wait_for(state="visible", timeout=10000)
            page.wait_for_timeout(1500)
            page.locator("#stopRecord").click()
            page.locator("#selectedFile audio").wait_for(state="visible")
            original = base64.b64decode(page.evaluate("""async () => {
              const url = document.querySelector('#selectedFile audio').src;
              const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
              let encoded = ''; for (let i=0;i<bytes.length;i+=32768)
                encoded += String.fromCharCode(...bytes.subarray(i,i+32768));
              return btoa(encoded);
            }"""))
            with wave.open(io.BytesIO(original), "rb") as audio:
                rate, channels, width, frames = audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getnframes()
                samples = [sample[0] for sample in struct.iter_unpack("<h", audio.readframes(frames))]
            nonzero = sum(sample != 0 for sample in samples)
            assert rate > 0 and channels == 1 and width == 2 and frames > rate // 2
            assert nonzero > 0, "Fake microphone did not produce nonzero PCM samples"
            original_hash = digest(original)
            page.locator("#encodeButton").click()
            page.locator("#senderResult").wait_for(state="visible", timeout=120000)
            artwork_path, token_path = scratch / "artwork.png", scratch / "token.json"
            art_name = download(page, "#downloadArt", artwork_path)
            token_name = download(page, "#downloadToken", token_path)
            token = json.loads(token_path.read_bytes())
            assert token["source_sha256"] == original_hash
            assert token["file_bytes"] == len(original)
            assert token["kind"] == "audio" and token["preview"] is None
            sender_hash_text = page.locator("#senderHash").text_content()
            assert original_hash in sender_hash_text
            sender.close()

            # The receiving browser has no source file or sender state.
            receiver = browser.new_context(accept_downloads=True)
            received = receiver.new_page()
            received.on("pageerror", lambda error: failures.append(str(error)))
            received.goto(base_url + "/?modo=recibir", wait_until="networkidle")
            received.wait_for_function("document.body.dataset.workerReady === 'true'")
            network_after_ready = []
            received.on("request", lambda request: network_after_ready.append(request.url)
                        if request.url.startswith(("http://", "https://")) else None)
            receiver.set_offline(True)
            received.locator("#receivedArt").set_input_files(artwork_path)
            received.locator("#receivedToken").set_input_files(token_path)
            received.locator("#decodeButton").click()
            received.locator("#receiverResult").wait_for(state="visible", timeout=120000)
            output = scratch / "recovered.wav"
            restored_name = download(received, "#downloadRestored", output)
            restored = output.read_bytes()
            assert restored == original
            assert original_hash in received.locator("#receiverHash").text_content()
            assert received.locator("#restoredPreview audio").count() == 1
            assert not network_after_ready, network_after_ready
            receiver.close()
            browser.close()
    assert not failures, failures
    return {"status": "PASS", "test": "frontend_fake_microphone_to_offline_recipient",
            "browser": "Microsoft Edge / Playwright", "url": base_url,
            "microphone_source": "Generated 440 Hz sine WAV via Chromium fake-device and fake-audio-capture flags; no real microphone",
            "recording_wait_ms": 1500, "recorded_file_bytes": len(original),
            "sample_rate_hz": rate, "channels": channels, "bits_per_sample": width * 8,
            "frame_count": frames, "duration_seconds": frames / rate,
            "nonzero_samples": nonzero, "max_absolute_sample": max(abs(value) for value in samples),
            "source_sha256": original_hash, "recovered_sha256": digest(restored),
            "byte_identical": True, "artwork_download": art_name, "token_download": token_name,
            "restored_filename": restored_name,
            "token_bytes": len(json.dumps(token, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")) + 1,
            "separate_recipient_context": True, "recipient_offline_before_import": True,
            "recipient_received_only_artwork_and_token": True,
            "network_requests_during_recovery": len(network_after_ready), "page_errors": failures,
            "seconds": round(time.perf_counter() - started, 3)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8770")
    args = parser.parse_args()
    report = run(args.base_url.rstrip("/"))
    (ROOT / "tests" / "VOICE_WEB_REPORT.json").write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="ascii")
    print(json.dumps(report, indent=2, ensure_ascii=True))
