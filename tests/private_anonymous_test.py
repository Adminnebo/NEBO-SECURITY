"""Check deployed private-site protection from fresh, unauthenticated browsers.

Never signs in, supplies a bypass, follows login links, or records authentication
parameters, cookies, response bodies or arbitrary page text. Each route receives
its own new browser context with empty initial cookies and storage.
"""
import argparse
import json
from pathlib import Path
import time
from urllib.parse import urlsplit, urlunsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
DEFAULT_URL = 'https://astra-pixel-mensajes-lucas.lucasarmando417.chatgpt.site'
ROUTES = [
    ('root', '/'),
    ('receiver_link', '/?modo=recibir'),
    ('html', '/index.html'),
    ('app_script', '/app.js'),
    ('crypto_worker', '/secure-worker.js'),
    ('service_worker', '/sw.js'),
    ('manifest', '/manifest.webmanifest'),
    ('access_check_if_deployed', '/access-check.json'),
]


def safe_url(value):
    """Deliberately discard user info, queries and fragments before logging."""
    parsed = urlsplit(value)
    hostname = parsed.hostname or ''
    netloc = hostname + (f':{parsed.port}' if parsed.port else '')
    return urlunsplit((parsed.scheme, netloc, parsed.path or '/', '', ''))


def known_payload_exposed(route, data):
    pathname = urlsplit(route).path
    source_path = ROOT / 'public' / ('index.html' if pathname == '/' else pathname.lstrip('/'))
    exact_match = source_path.is_file() and source_path.read_bytes() == data
    text = data.decode('utf-8', errors='replace')
    signatures = {
        '/': ['id="sourceFile"', 'id="encodeButton"', 'id="receivedArt"'],
        '/index.html': ['id="sourceFile"', 'id="encodeButton"', 'id="receivedArt"'],
        '/app.js': ['function setReceived(', "from './bundle.js'", "from './secure-worker.js'"],
        '/secure-worker.js': ['ASTRA-SECURE-V2', 'export async function', 'AES-256-GCM'],
        '/sw.js': ['self.addEventListener(', 'caches.'],
        '/manifest.webmanifest': ['"start_url"', '"icons"', 'NEBO'],
        '/access-check.json': ['"private"', '"access"'],
    }
    markers = signatures.get(pathname, [])
    matching_markers = sum(marker in text for marker in markers)
    # Access-check schemas may change. A successful JSON response is separately
    # reported as unprotected; matching this local file is already conclusive.
    recognizable = matching_markers >= (2 if len(markers) > 1 else 1)
    return exact_match or recognizable


def inspect_route(browser, base_url, label, route):
    context = browser.new_context(accept_downloads=False, viewport={'width':1280, 'height':900})
    assert context.cookies() == [], 'A fresh context must start without cookies'
    page = context.new_page()
    response_chain = []
    page.on('response', lambda response: response_chain.append({
        'url': safe_url(response.url), 'status': response.status,
    }) if response.request.is_navigation_request() else None)
    result = {'route':label, 'requested_url':safe_url(base_url + route),
              'receiver_mode_parameter':label == 'receiver_link',
              'fresh_context':True, 'initial_cookie_count':0,
              'login_clicked':False, 'bypass_used':False}
    try:
        response = page.goto(base_url + route, wait_until='domcontentloaded', timeout=45000)
        page.wait_for_timeout(500)
        assert response is not None
        data = response.body()
        text = data.decode('utf-8', errors='replace').lower()
        rendered = page.locator('body').inner_text(timeout=5000).lower()
        title = page.title().lower()
        selectors = page.locator('#sourceFile,#encodeButton,#receivedArt').count()
        # Inspect provider hints in memory only. No links or page text are logged.
        hints = text + '\n' + rendered
        chatgpt = 'chatgpt' in hints
        openai = 'openai' in hints
        sign_in_required = 'sign in required' in title or 'sign in required' in hints
        login_prompt = any(marker in hints for marker in (
            'sign in', 'sign-in', 'signin', 'log in', 'login', 'authentication required',
            'unauthorized', 'acceso restringido', 'iniciar sesi', 'access denied'))
        payload_exposed = known_payload_exposed(route, data) or selectors > 0
        status = response.status
        final_host = urlsplit(page.url).hostname or ''
        redirected_to_provider = final_host != (urlsplit(base_url).hostname or '') and (
            final_host.endswith('.openai.com') or final_host.endswith('.chatgpt.com') or
            final_host in ('chatgpt.com', 'openai.com'))
        if payload_exposed:
            category = 'application_payload_exposed'
        elif status in (401, 403):
            category = 'sign_in_required' if sign_in_required or login_prompt else 'access_denied'
        elif redirected_to_provider and login_prompt:
            category = 'provider_login_redirect'
        elif status == 200 and login_prompt:
            category = 'provider_login_gate'
        elif status == 404 and label == 'access_check_if_deployed':
            category = 'optional_access_check_not_found'
        else:
            category = 'unconfirmed_protection'
        result.update({
            'status':status, 'final_url':safe_url(page.url),
            'navigation_responses':response_chain,
            'category':category,
            'content_type':response.headers.get('content-type', '').split(';', 1)[0],
            'response_bytes':len(data),
            'login_prompt_detected':login_prompt,
            'sign_in_required_title_or_body':sign_in_required,
            'provider_hint':'ChatGPT' if chatgpt else 'OpenAI' if openai else 'unspecified',
            'application_controls':selectors,
            'application_payload_exposed':payload_exposed,
            'passed':category in ('sign_in_required','access_denied','provider_login_redirect',
                                  'provider_login_gate','optional_access_check_not_found'),
        })
    except Exception as exc:
        # Exception messages may contain full redirect URLs. Record the type only.
        result.update({'passed':False, 'category':'inspection_error', 'error_type':type(exc).__name__,
                       'navigation_responses':response_chain})
    finally:
        context.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default=DEFAULT_URL)
    parser.add_argument('--report', type=Path, default=ROOT / 'tests/PRIVATE_ANONYMOUS_REPORT.json')
    args = parser.parse_args()
    parts = urlsplit(args.base_url)
    if parts.scheme not in ('http', 'https') or parts.username or parts.password or parts.query or parts.fragment:
        parser.error('Use a plain site origin without credentials, query or fragment.')
    base_url = args.base_url.rstrip('/')
    started = time.monotonic()
    report = {'status':'RUNNING', 'base_url':safe_url(base_url), 'checks':[],
              'browser':'Microsoft Edge', 'anonymous':True, 'contexts_reused':False,
              'authentication_attempted':False, 'bypass_used':False,
              'records_cookies_or_authentication_parameters':False,
              'scope':'Fresh anonymous access only; authenticated-owner access is not tested.'}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=EDGE, headless=True)
        for label, route in ROUTES:
            result = inspect_route(browser, base_url, label, route)
            report['checks'].append(result)
            print(json.dumps({'route':label, 'status':result.get('status'),
                              'category':result['category'], 'passed':result['passed']}), flush=True)
        browser.close()
    report['status'] = 'PASS' if all(check['passed'] for check in report['checks']) else 'FAIL'
    report['application_payloads_exposed'] = sum(bool(check.get('application_payload_exposed')) for check in report['checks'])
    report['seconds'] = round(time.monotonic() - started, 3)
    args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status':report['status'], 'checks':len(report['checks']),
                      'application_payloads_exposed':report['application_payloads_exposed'],
                      'seconds':report['seconds']}), flush=True)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
