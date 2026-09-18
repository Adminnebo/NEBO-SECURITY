"""Real browser multi-attachment audit, using synthetic inputs only.

Run after starting the app: python tests/multi_message_test.py --base-url URL
No real microphone, identity, location, or recovery key is written to reports.
"""
import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import struct
import time
import traceback
import wave
import zipfile

from PIL import Image
from playwright.sync_api import sync_playwright, expect
from secure_audit_core import oracle

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'tests' / 'MULTI_MESSAGE_REPORT.json'
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
CAPTURE = """(() => {
  window.__auditCreatedFiles = [];
  window.__auditLocationCalls = 0;
  const getLocation = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
  navigator.geolocation.getCurrentPosition = (...args) => {window.__auditLocationCalls++; return getLocation(...args)};
  window.File = new Proxy(window.File, {construct(Target, args, NewTarget) {
    const result = Reflect.construct(Target, args, NewTarget);
    window.__auditCreatedFiles.push(result); return result;
  }});
})()"""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def wait_ready(page):
    page.locator('body[data-worker-ready="true"]').wait_for(timeout=45000)


def wait_result(page, side, previous=None):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if page.locator(f'#{side}Error:not(.hidden)').count():
            raise AssertionError(page.locator(f'#{side}Error').inner_text())
        if page.locator(f'#{side}Result:not(.hidden)').count():
            selector = '#downloadArt' if side == 'sender' else '#downloadRestored'
            href = page.locator(selector).get_attribute('href')
            if href and href != previous:
                return
        time.sleep(.1)
    raise AssertionError(f'Timed out waiting for {side}')


def download(page, item):
    item = page.locator(item) if isinstance(item, str) else item
    with page.expect_download(timeout=60000) as download_info:
        item.click()
    result = download_info.value
    return Path(result.path()).read_bytes(), result.suggested_filename


def upload(name, mime, data):
    return {'name': name, 'mimeType': mime, 'buffer': data}


def supplied_fixtures():
    image = Image.new('RGBA', (41, 27), (17, 113, 207, 155))
    buf = io.BytesIO(); image.save(buf, 'PNG')
    pdf = (ROOT / 'tests/fixtures/pdf_two_pages/original.bin').read_bytes()
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(8000)
        wav.writeframes(b''.join(struct.pack('<h', (n % 200 - 100) * 120) for n in range(1600)))
    return [upload('montaña_ñ.png', 'image/png', buf.getvalue()),
            upload('documento.pdf', 'application/pdf', pdf),
            upload('datos.bin', 'application/octet-stream', bytes(range(256)) * 11),
            upload('datos.bin', 'application/octet-stream', b'INDEPENDENT SAME NAME\x00\xff\xfe'),
            upload('audio.wav', 'audio/wav', audio.getvalue())]


def set_receiver(page, art, token, secret=None):
    page.locator('#receivedArt').set_input_files(upload('obra.png', 'image/png', art))
    page.locator('#receivedToken').set_input_files(upload('token.json', 'application/json', token))
    if secret is not None:
        page.locator('#receivedSecret').fill(secret)


def permission(context, page, setting, origin):
    if setting == 'granted':
        context.grant_permissions(['geolocation', 'microphone'], origin=origin)
        context.set_geolocation({'latitude':18.5, 'longitude':-69.9})
        page.wait_for_timeout(200)
        return
    cdp = context.new_cdp_session(page)
    info = cdp.send('Target.getTargetInfo')['targetInfo']
    cdp.send('Browser.setPermission', {
        'permission': {'name': 'geolocation'}, 'setting': setting,
        'origin': origin, 'browserContextId': info['browserContextId']})
    cdp.detach()
    page.wait_for_timeout(200)


def run(args, report):
    checks = report['checks']
    def passed(label, **details):
        checks.append({'test': label, 'passed': True, **details})
        print('PASS ' + label, flush=True)
    fixtures = supplied_fixtures()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=EDGE, headless=True,
            args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
        context = browser.new_context(accept_downloads=True, viewport={'width':1440, 'height':1050},
            geolocation={'latitude':18.5, 'longitude':-69.9}, permissions=['microphone'])
        context.add_init_script(CAPTURE)
        sender = context.new_page()
        sender.on('pageerror', lambda error: report['page_errors'].append(str(error)))
        sender.on('console', lambda msg: report['console_errors'].append(msg.text) if msg.type == 'error' else None)
        assert sender.goto(args.base_url, wait_until='networkidle').status == 200
        wait_ready(sender)
        assert sender.locator('#sourceFile').get_attribute('multiple') is not None
        rows = sender.locator('#selectedFile .attachment-row')
        sender.locator('#sourceFile').set_input_files(fixtures[:2]); expect(rows).to_have_count(2)
        sender.locator('#sourceFile').set_input_files(fixtures[2:]); expect(rows).to_have_count(5)
        # Identical filename and bytes can be intentionally added; removal is by item.
        sender.locator('#sourceFile').set_input_files(fixtures[0]); expect(rows).to_have_count(6)
        rows.last.locator('.remove-attachment').click(); expect(rows).to_have_count(5)
        rows.nth(1).locator('.remove-attachment').click(); expect(rows).to_have_count(4)
        sender.locator('#sourceFile').set_input_files(fixtures[1]); expect(rows).to_have_count(5)
        assert sender.locator('#selectedFile').inner_text().count('datos.bin') == 2
        passed('Multiple upload appends; duplicate names coexist; targeted removal preserves all other items')

        message = 'Mensaje privado: café, montaña, firma 签名.\nSegunda línea exacta.'
        sender.locator('#textButton').click(); sender.locator('#textInput').fill(message)
        sender.locator('#useText').click(); expect(rows).to_have_count(6)
        passed('Composed UTF-8 message appends to existing image, PDF, binary and WAV attachments')

        # Explicit browser permission denial, followed by manual fallback.
        origin = sender.evaluate('() => location.origin')
        assert sender.evaluate('() => window.__auditLocationCalls') == 0
        permission(context, sender, 'denied', origin)
        sender.locator('#locationButton').click(); sender.locator('#useCurrentLocation').click()
        expect(sender.locator('#locationStatus')).to_contain_text('No se concedió')
        assert sender.evaluate('() => window.__auditLocationCalls') == 1
        assert sender.locator('#locationLatitude').input_value() == ''
        sender.locator('#locationLabel').fill('Lugar sintético de prueba')
        sender.locator('#locationLatitude').fill('18.5'); sender.locator('#locationLongitude').fill('-69.9')
        sender.locator('#addLocation').click(); expect(rows).to_have_count(7)
        passed('Denied geolocation permission preserves draft; manual synthetic location remains usable')
        permission(context, sender, 'granted', origin)
        sender.locator('#locationButton').click(); sender.locator('#useCurrentLocation').click()
        expect(sender.locator('#locationLatitude')).to_have_value('18.5')
        expect(sender.locator('#locationLongitude')).to_have_value('-69.9')
        sender.locator('#addLocation').click(); expect(rows).to_have_count(8)
        rows.last.locator('.remove-attachment').click(); expect(rows).to_have_count(7)
        passed('Granted mocked browser geolocation populates coordinates only after explicit user click')

        sender.locator('#recordButton').click()
        sender.locator('#recording:not(.hidden)').wait_for(timeout=30000)
        sender.wait_for_timeout(900)
        sender.locator('#stopRecord').click(); expect(rows).to_have_count(8, timeout=30000)
        recorded = sender.evaluate("""async () => {
          const files = window.__auditCreatedFiles.filter(f => /^nota-de-voz-/.test(f.name));
          return await Promise.all(files.map(async f => ({name:f.name,type:f.type,data:Array.from(new Uint8Array(await f.arrayBuffer()))})));
        }""")
        assert len(recorded) == 1 and bytes(recorded[0]['data']).startswith(b'RIFF')
        with wave.open(io.BytesIO(bytes(recorded[0]['data'])), 'rb') as wav:
            assert wav.getnframes() > 0 and wav.getnchannels() == 1
        passed('Real browser recording with fake microphone adds a valid WAV without replacing attachments', recorded_bytes=len(recorded[0]['data']))

        # Capture generated originals before encoding, independently of the bundle parser.
        created = sender.evaluate("""async () => await Promise.all(window.__auditCreatedFiles.map(async f => ({name:f.name,type:f.type,data:Array.from(new Uint8Array(await f.arrayBuffer()))})))""")
        text_files = [f for f in created if bytes(f['data']) == message.encode('utf-8')]
        assert len(text_files) == 1
        location_files = [f for f in created if 'geo' in f['type'] or 'ubicaci' in f['name'].lower() or 'location' in f['name'].lower()]
        assert location_files, 'Manual location original must be captured before encoding'
        location_original = bytes(location_files[0]['data'])
        geo = json.loads(location_original)
        assert geo['type'] == 'Feature' and geo['geometry']['type'] == 'Point'
        assert geo['geometry']['coordinates'] == [-69.9, 18.5]
        expected = [f['buffer'] for f in fixtures] + [message.encode('utf-8'), location_original, bytes(recorded[0]['data'])]

        for width, theme in [(390, 'light'), (320, 'dark')]:
            sender.set_viewport_size({'width':width, 'height':844})
            sender.evaluate('(theme) => {document.documentElement.dataset.theme=theme}', theme)
            sender.wait_for_timeout(250)
            assert sender.evaluate('() => document.documentElement.scrollWidth <= innerWidth + 1')
            shot = ROOT / 'tests' / f'multi-{width}-{theme}.png'
            sender.screenshot(path=str(shot), full_page=True)
        passed('Mixed attachment composer has no horizontal overflow at 390 light and 320 dark', screenshots=['tests/multi-390-light.png', 'tests/multi-320-dark.png'])
        sender.set_viewport_size({'width':1440, 'height':1050})
        sender.locator('#encodeButton').click(); wait_result(sender, 'sender')
        art, _ = download(sender, '#downloadArt'); token, _ = download(sender, '#downloadToken')
        secret = sender.locator('#recoverySecret').input_value()
        plaintext, meta, _, _ = oracle(art, token, secret=secret)
        assert len(secret) == 43 and plaintext[:4] == b'PK\x03\x04'
        passed('Eight mixed attachments produce one independently authenticated PNG/token/secret', artwork_bytes=len(art), token_bytes=len(token), plaintext_bytes=len(plaintext))

        # Receiver gets no source files, sender state, or network after static load.
        rc = browser.new_context(accept_downloads=True, viewport={'width':1440,'height':1050})
        receiver = rc.new_page()
        receiver.on('pageerror', lambda error: report['page_errors'].append(str(error)))
        receiver.on('console', lambda msg: report['console_errors'].append(msg.text) if msg.type == 'error' else None)
        assert receiver.goto(args.base_url, wait_until='networkidle').status == 200
        wait_ready(receiver)
        rc.route('**/*', lambda route: (report['network_attempts_after_cutoff'].append(route.request.url), route.abort())[1])
        rc.set_offline(True)
        receiver.locator('#receiverTab').click(); set_receiver(receiver, art, token, 'A' * 43)
        receiver.locator('#decodeButton').click()
        receiver.locator('#receiverError:not(.hidden)').wait_for(timeout=60000)
        assert receiver.locator('#receiverResult').evaluate("e => e.classList.contains('hidden')")
        receiver.locator('#receivedSecret').fill(secret); receiver.locator('#decodeButton').click()
        wait_result(receiver, 'receiver')
        items = receiver.locator('#restoredPreview .restored-item'); expect(items).to_have_count(8)
        actual = []
        for index in range(8):
            data, name = download(receiver, items.nth(index).locator('.attachment-download'))
            actual.append(data)
        assert Counter(map(sha, actual)) == Counter(map(sha, expected)), 'Per-item exact originals differ'
        restored_zip, zip_name = download(receiver, '#downloadRestored')
        assert restored_zip == plaintext and zip_name.lower().endswith('.zip')
        assert receiver.locator('#restoredPreview iframe,#restoredPreview object,#restoredPreview embed').count() == 0
        passed('Fresh offline recipient rejects wrong key, then downloads every exact original and whole exact ZIP', attachment_count=len(actual), attachment_sha256=sorted(map(sha, actual)), zip_sha256=sha(restored_zip))
        with zipfile.ZipFile(io.BytesIO(restored_zip)) as zf:
            assert zf.testzip() is None
            names = zf.namelist(); assert len(names) == len(set(names))
            assert all(not name.startswith(('/', '\\')) and '..' not in name.replace('\\','/').split('/') for name in names)
            manifest_names = [name for name in names if name == 'manifest.json' or name.endswith('/manifest.json')]
            assert len(manifest_names) == 1
            bundle_manifest = json.loads(zf.read(manifest_names[0]))
            assert bundle_manifest['format'] == 'NEBO-BUNDLE-V1' and bundle_manifest['version'] == 1
            assert len(bundle_manifest['items']) == 8
            for item in bundle_manifest['items']:
                content = zf.read(item['path'])
                assert len(content) == item['bytes'] and sha(content) == item['sha256']
            files = [zf.read(name) for name in names if name not in manifest_names and not name.endswith('/')]
            assert Counter(map(sha, files)) == Counter(map(sha, expected))
        passed('Independent Python zipfile validates CRCs, unique safe member paths and exact original byte multiset', manifest_format=bundle_manifest.get('format'), zip_member_count=len(names))

        for width, theme in [(390, 'light'), (320, 'dark')]:
            receiver.set_viewport_size({'width':width, 'height':844})
            receiver.evaluate('(theme) => {document.documentElement.dataset.theme=theme}', theme)
            receiver.wait_for_timeout(250)
            assert receiver.evaluate('() => document.documentElement.scrollWidth <= innerWidth + 1')
            receiver.screenshot(path=str(ROOT / 'tests' / f'multi-received-{width}-{theme}.png'), full_page=True)
        receiver.set_viewport_size({'width':1440, 'height':1050})
        passed('Recovered mixed attachment cards fit 390 light and 320 dark without horizontal overflow')

        # Fresh single-file operation must remain a direct original, not a ZIP.
        while rows.count():
            rows.last.locator('.remove-attachment').click()
        sender.locator('#sourceFile').set_input_files(fixtures[0]); expect(rows).to_have_count(1)
        old = sender.locator('#downloadArt').get_attribute('href')
        sender.locator('#encodeButton').click(); wait_result(sender, 'sender', old)
        single_art, _ = download(sender, '#downloadArt'); single_token, _ = download(sender, '#downloadToken')
        single_secret = sender.locator('#recoverySecret').input_value()
        single, _, _, _ = oracle(single_art, single_token, secret=single_secret)
        assert single == fixtures[0]['buffer']
        previous = receiver.locator('#downloadRestored').get_attribute('href')
        set_receiver(receiver, single_art, single_token, single_secret)
        receiver.locator('#decodeButton').click(); wait_result(receiver, 'receiver', previous)
        single_bytes, single_name = download(receiver, '#downloadRestored')
        assert single_bytes == fixtures[0]['buffer'] and single_name == fixtures[0]['name']
        passed('Single-file private sender/receiver still returns exact standalone original')
        legacy = ROOT / 'tests/fixtures/png_alpha'
        previous = receiver.locator('#downloadRestored').get_attribute('href')
        set_receiver(receiver, (legacy / 'artwork.png').read_bytes(), (legacy / 'token.json').read_bytes())
        receiver.locator('#decodeButton').click(); wait_result(receiver, 'receiver', previous)
        old_bytes, _ = download(receiver, '#downloadRestored')
        assert old_bytes == (legacy / 'original.bin').read_bytes()
        passed('Classic ASTRA-MSG-V1 package remains decodable offline')
        assert not report['page_errors'], report['page_errors']
        # Browsers may request the favicon late. It is blocked like everything else;
        # it is not used by the decoder and cannot contain originals or keys.
        report['optional_favicon_requests_blocked'] = [url for url in report['network_attempts_after_cutoff']
            if url == args.base_url.rstrip('/') + '/assets/nebo-symbol.svg']
        report['functional_network_attempts_after_cutoff'] = [url for url in report['network_attempts_after_cutoff']
            if url not in report['optional_favicon_requests_blocked']]
        assert not report['functional_network_attempts_after_cutoff'], report['functional_network_attempts_after_cutoff']
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8774')
    args = parser.parse_args()
    started = time.monotonic()
    report = {'status':'RUNNING', 'base_url':args.base_url, 'checks':[], 'page_errors':[],
              'console_errors':[], 'network_attempts_after_cutoff':[], 'browser':'Microsoft Edge',
              'synthetic_microphone':True, 'synthetic_location':True,
              'anonymous_fresh_receiver_context':True, 'receiver_offline_after_static_load':True,
              'secrets_logged':False}
    try:
        run(args, report); report['status'] = 'PASS'
    except Exception as exc:
        report['status'] = 'FAIL'; report['failure'] = str(exc)
        report['traceback'] = traceback.format_exc()
        raise
    finally:
        report['seconds'] = round(time.monotonic() - started, 3)
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'status':report['status'], 'checks':len(report['checks']), 'seconds':report['seconds']}), flush=True)
