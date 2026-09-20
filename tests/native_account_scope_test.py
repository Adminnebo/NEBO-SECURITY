"""Verify account-scoped IndexedDB with real Worker/D1 sessions in one browser.

Creates and disables one synthetic member. Does not export private CryptoKeys,
save cookies/passwords, or treat browser storage separation as OS isolation.
The default password is strictly for this disposable local test environment.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import traceback
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'


def run(base, report):
    local = urlsplit(base).hostname in ('localhost', '127.0.0.1')
    username = os.environ.pop('NEBO_TEST_LOGIN_USER', 'admin' if local else '')
    password = os.environ.pop('NEBO_TEST_LOGIN_PASSWORD', 'Local-NEBO-Prueba-2026!' if local else '')
    if not username or not password:
        raise ValueError('Non-local targets require explicit test credentials in the environment.')
    member_name = 'scope_qa_' + secrets.token_hex(5)
    member_password = secrets.token_urlsafe(18)
    member_id = None
    admin_logins = 0
    context = None

    def passed(name, **details):
        report['checks'].append({'test': name, 'passed': True, **details})
        print('PASS ' + name, flush=True)

    def post(path, data, csrf=None, method='POST'):
        headers = {'Origin': base}
        if csrf:
            headers['X-CSRF-Token'] = csrf
        return context.request.fetch(base + path, method=method, data=data, headers=headers)

    def admin_login():
        nonlocal admin_logins
        assert admin_logins < 2, 'At most two administrator logins are permitted.'
        admin_logins += 1
        response = post('/api/auth/login', {'username': username, 'password': password})
        assert response.status == 200, 'Administrator login must succeed.'
        result = response.json()
        assert result['user']['role'] == 'admin'
        return result

    def ready(page, expected_id):
        page.locator('body[data-access="granted"][data-worker-ready="true"]').wait_for(timeout=45000)
        assert page.evaluate('window.NEBO_ACCESS.user.id') == expected_id

    def revalidate_and_reload(page, expected_id):
        previous_document = page.evaluate('performance.timeOrigin')
        with page.expect_navigation(wait_until='domcontentloaded', timeout=30000):
            page.evaluate('void window.NEBO_ACCESS.require()')
        ready(page, expected_id)
        assert page.evaluate('performance.timeOrigin') != previous_document

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=EDGE, headless=True,
                                    args=['--ignore-certificate-errors'] if local else [])
        context = browser.new_context(viewport={'width': 320, 'height': 844}, ignore_https_errors=local)
        page = context.new_page()
        page.on('pageerror', lambda error: report['page_error_types'].append(type(error).__name__))
        try:
            admin_session = admin_login()
            admin_id = admin_session['user']['id']
            page.goto(base + '/', wait_until='domcontentloaded')
            ready(page, admin_id)
            admin_identity = page.evaluate('''async () => {
                const {createIdentity, loadIdentity} = await import('/identity-store.js');
                const {saveContact, listContacts} = await import('/contact-store.js');
                const {accountDatabaseName} = await import('/account-storage.js');
                const created = await createIdentity();
                const loaded = await loadIdentity();
                await saveContact('Admin test contact', created.publicBundle);
                return {
                    fingerprint: loaded.publicBundle.fingerprint,
                    pairVerified: created.publicBundle.fingerprint === loaded.publicBundle.fingerprint,
                    nonExportable: loaded.privateKey.extractable === false,
                    privateKeyType: loaded.privateKey.type,
                    legacyDatabase: accountDatabaseName('astra-private-identities-v1') === 'astra-private-identities-v1',
                    contacts: (await listContacts()).length,
                };
            }''')
            assert admin_identity['pairVerified'] and admin_identity['nonExportable']
            assert admin_identity['privateKeyType'] == 'private'
            assert admin_identity['legacyDatabase'] and admin_identity['contacts'] == 1
            passed('Administrator retains the legacy identity database and a verified non-exportable key pair')

            response = post('/api/admin/users', {'username': member_name, 'password': member_password,
                                                'displayName': 'Account scope QA'}, admin_session['csrfToken'])
            assert response.status == 201
            member_id = response.json()['user']['id']
            response = post('/api/auth/login', {'username': member_name, 'password': member_password})
            assert response.status == 200 and response.json()['user']['id'] == member_id
            # The request context updates the SAME browser cookie jar, like a
            # second tab logging in as another user while this app stays open.
            assert page.evaluate('window.NEBO_ACCESS.user.id') == admin_id
            revalidate_and_reload(page, member_id)
            passed('A changed account cookie forces the already-open app to reload before using the new account')

            member_fresh = page.evaluate('''async () => {
                const {loadIdentity} = await import('/identity-store.js');
                const {listContacts} = await import('/contact-store.js');
                const {accountDatabaseName} = await import('/account-storage.js');
                return {
                    emptyIdentity: (await loadIdentity()) === null,
                    contacts: (await listContacts()).length,
                    scopedDatabase: accountDatabaseName('astra-private-identities-v1') ===
                        'astra-private-identities-v1-account-' + window.NEBO_ACCESS.user.id,
                };
            }''')
            assert member_fresh['emptyIdentity'] and member_fresh['contacts'] == 0 and member_fresh['scopedDatabase']
            passed('The fresh member sees neither the administrator identity nor administrator contacts')

            member_identity = page.evaluate('''async () => {
                const {createIdentity, loadIdentity} = await import('/identity-store.js');
                const {saveContact, listContacts} = await import('/contact-store.js');
                const created = await createIdentity();
                const loaded = await loadIdentity();
                await saveContact('Member test contact', created.publicBundle);
                return {
                    fingerprint: loaded.publicBundle.fingerprint,
                    pairVerified: created.publicBundle.fingerprint === loaded.publicBundle.fingerprint,
                    nonExportable: loaded.privateKey.extractable === false,
                    contacts: (await listContacts()).length,
                };
            }''')
            assert member_identity['pairVerified'] and member_identity['nonExportable']
            assert member_identity['fingerprint'] != admin_identity['fingerprint'] and member_identity['contacts'] == 1
            passed('The member creates a different verified non-exportable identity and a separate contact')

            admin_session = admin_login()
            revalidate_and_reload(page, admin_id)
            restored = page.evaluate('''async () => {
                const {loadIdentity} = await import('/identity-store.js');
                const {listContacts} = await import('/contact-store.js');
                const identity = await loadIdentity();
                const contacts = await listContacts();
                return {
                    fingerprint: identity.publicBundle.fingerprint,
                    nonExportable: identity.privateKey.extractable === false,
                    contacts: contacts.map(contact => contact.name),
                };
            }''')
            assert restored['fingerprint'] == admin_identity['fingerprint'] and restored['nonExportable']
            assert restored['contacts'] == ['Admin test contact']
            passed('Returning to the administrator restores the original identity and only its original contact')

            report['mobile_layout'] = page.evaluate('''() => ({
                viewportWidth: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                overflowingNodes: [...document.querySelectorAll('body *')].filter(node => {
                    const rect = node.getBoundingClientRect();
                    return rect.width > 0 && rect.right > innerWidth + 0.5;
                }).map(node => ({tag: node.tagName, id: node.id,
                    className: typeof node.className === 'string' ? node.className : '',
                    right: Math.round(node.getBoundingClientRect().right * 100) / 100,
                    width: Math.round(node.getBoundingClientRect().width * 100) / 100})).slice(0, 30),
            })''')
            screenshot = ROOT / 'tests/ui-v11/app320.png'
            screenshot.parent.mkdir(exist_ok=True)
            page.screenshot(path=str(screenshot), full_page=True)
            report['mobile_screenshot'] = 'tests/ui-v11/app320.png'
            assert report['mobile_layout']['documentWidth'] <= report['mobile_layout']['viewportWidth']
            expect(page.locator('a[href="/account"]')).to_be_visible()
            passed('The real authenticated application and account link fit a 320px mobile viewport')
            assert not report['page_error_types']
        finally:
            if member_id and context:
                current = context.request.get(base + '/api/auth/session')
                current_data = current.json() if current.status == 200 else {}
                if current_data.get('user', {}).get('role') != 'admin' and admin_logins < 2:
                    current_data = admin_login()
                if current_data.get('user', {}).get('role') == 'admin':
                    cleanup = post('/api/admin/users/' + member_id, {'disabled': True},
                                   current_data['csrfToken'], method='PATCH')
                    report['synthetic_user_disabled_after_test'] = cleanup.status == 200
            report['administrator_logins'] = admin_logins
            browser.close()
        assert report.get('synthetic_user_disabled_after_test') is True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='https://127.0.0.1:8789')
    parser.add_argument('--report', default=str(ROOT / 'tests/NATIVE_ACCOUNT_SCOPE_REPORT.json'))
    args = parser.parse_args()
    report = {
        'base_url': args.base_url,
        'backend': 'Real local Wrangler Worker and D1',
        'same_browser_context_for_account_switches': True,
        'private_keys_exported': False,
        'credentials_recorded': False,
        'storage_boundary': 'Account-scoped normal UI; not isolation from a person controlling this browser or OS',
        'checks': [],
        'page_error_types': [],
    }
    try:
        run(args.base_url.rstrip('/'), report)
        report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['error_type'] = type(error).__name__
        last = traceback.extract_tb(error.__traceback__)[-1]
        report['error_location'] = {'file': Path(last.filename).name, 'line': last.lineno}
    Path(args.report).write_text(json.dumps(report, indent=2) + '\n', encoding='utf8', newline='\n')
    print(json.dumps({'passed': report['passed'], 'checks': len(report['checks']),
                      'error_location': report.get('error_location')}))
    raise SystemExit(0 if report['passed'] else 1)
