"""Real Worker + D1 + browser account audit. Credentials arrive only via env.

Creates one synthetic user and disables it at the end. Does not send messages,
save passwords/cookies in the report, or automate an external identity provider.
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
    username = os.environ.pop('NEBO_TEST_LOGIN_USER')
    password = os.environ.pop('NEBO_TEST_LOGIN_PASSWORD')
    host_token = os.environ.pop('NEBO_SITES_AUDIT_TOKEN', '')
    report['hosting_test_header_used'] = bool(host_token)
    report['login_kind'] = 'NEBO username/password with server cookie'
    test_user = 'qa_' + secrets.token_hex(5)
    test_password = secrets.token_urlsafe(18)
    replacement = secrets.token_urlsafe(18)
    origin = base.rstrip('/')
    user_id = None
    admin = None
    csrf = None
    def passed(name, **details):
        report['checks'].append({'test':name, 'passed':True, **details})
        print('PASS ' + name, flush=True)
    with sync_playwright() as pw:
        local = urlsplit(base).hostname in ('localhost','127.0.0.1')
        browser = pw.chromium.launch(executable_path=EDGE, headless=True,
                                     args=['--ignore-certificate-errors'] if local else [])
        def context(width=390):
            headers = {'OAI-Sites-Authorization':'Bearer ' + host_token} if host_token else {}
            ctx = browser.new_context(viewport={'width':width,'height':844},
                                      ignore_https_errors=True, extra_http_headers=headers)
            if host_token:
                def safe_route(route):
                    url = urlsplit(route.request.url)
                    if url.scheme in ('http','https') and url.netloc != urlsplit(base).netloc:
                        route.abort()
                    elif url.path == '/sw.js':
                        route.continue_(headers={**route.request.headers, **headers})
                    else:
                        route.continue_()
                ctx.route('**/*', safe_route)
            return ctx
        def post(ctx, path, data=None, token=None, method='POST', requested_origin=origin):
            headers = {'Origin':requested_origin}
            if token: headers['X-CSRF-Token'] = token
            return ctx.request.fetch(base+path, method=method, headers=headers, data=data)
        def login(ctx, user, secret):
            response = post(ctx, '/api/auth/login', {'username':user,'password':secret})
            assert response.status == 200, 'Expected successful account login'
            return response.json()
        def check_width(page):
            return page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        anon = context(320)
        try:
            guest = anon.new_page()
            guest.goto(base+'/', wait_until='networkidle')
            expect(guest.locator('#loginForm')).to_be_visible()
            assert check_width(guest)
            assert guest.locator('#encodeButton').count() == 0
            guest.goto(base+'/?modo=recibir', wait_until='networkidle')
            assert 'next=%2F%3Fmodo%3Drecibir' in guest.url
            for path in ['/app.js','/access.js','/sw.js?v=11','/account.js','/manifest.webmanifest','/api/auth/session']:
                response = anon.request.get(base+path)
                assert response.status == 401, path
                assert 'no-store' in response.headers.get('cache-control','')
            passed('Anonymous users reach only the login; six private resources return 401')
            assert post(anon,'/api/auth/login',{'username':username,'password':'wrong-password-example'}).status == 401
            assert post(anon,'/api/auth/login',{'username':username,'password':password},requested_origin='https://example.invalid').status == 403
            assert post(anon,'/api/auth/login',{'username':'x'*17000,'password':'a'}).status == 413
            passed('Wrong password, foreign Origin and oversized login body are rejected')

            admin = context()
            page = admin.new_page()
            page.on('pageerror', lambda error: report['page_error_types'].append(type(error).__name__))
            page.goto(base+'/login', wait_until='networkidle')
            page.locator('#username').fill(username)
            page.locator('#password').fill(password)
            page.locator('#loginSubmit').click()
            page.locator('body[data-worker-ready="true"]').wait_for(timeout=45000)
            expect(page.locator('#liveCoverImage')).to_be_visible()
            assert check_width(page)
            cookies = [c for c in admin.cookies() if c['name']=='__Host-nebo_session']
            assert len(cookies)==1 and cookies[0]['httpOnly'] and cookies[0]['secure'] and cookies[0]['sameSite']=='Lax'
            assert '__Host-nebo_session' not in page.evaluate('document.cookie')
            passed('Real login opens the app; session cookie is Secure, HttpOnly and SameSite=Lax')

            page.goto(base+'/account', wait_until='networkidle')
            expect(page.locator('#adminSection')).to_be_visible()
            session = admin.request.get(base+'/api/auth/session').json()
            csrf = session['csrfToken']
            assert post(admin,'/api/admin/users',{'username':test_user,'password':test_password,'displayName':'QA'}).status == 403
            assert post(admin,'/api/admin/users',{'username':test_user,'password':test_password,'displayName':'QA'},'wrong-token').status == 403
            passed('Administrative changes require a valid anti-CSRF token')

            page.locator('#newDisplayName').fill('Persona de prueba')
            page.locator('#newUsername').fill(test_user)
            page.locator('#newUserPassword').fill(test_password)
            page.locator('#createUserForm button[type=submit]').click()
            expect(page.locator('#credentialsResult')).to_be_visible(timeout=15000)
            assert page.locator('#credentialUsername').input_value()==test_user
            assert page.locator('#credentialPassword').input_value()==test_password
            rows = admin.request.get(base+'/api/admin/users').json()['users']
            created = next(row for row in rows if row['username']==test_user)
            user_id = created['id']
            assert created['role']=='user'
            assert not any('password' in key or 'hash' in key for row in rows for key in row)
            page.locator('#clearCredentials').click()
            expect(page.locator('#credentialsResult')).to_be_hidden()
            assert page.locator('#credentialPassword').input_value()==''
            assert check_width(page)
            passed('Admin creates a user in the real UI; credentials can be cleared; hashes never appear in user listings')

            member = context()
            member_session = login(member,test_user,test_password)
            userpage = member.new_page()
            userpage.goto(base+'/account', wait_until='networkidle')
            expect(userpage.locator('#accountContent')).to_be_visible()
            expect(userpage.locator('#adminSection')).to_be_hidden()
            assert member.request.get(base+'/api/admin/users').status == 403
            assert post(member,'/api/admin/users',{'username':'elevated','password':test_password},member_session['csrfToken']).status == 403
            passed('A separate user can enter with just username/password and cannot administer accounts')

            assert post(admin,f'/api/admin/users/{user_id}',{'disabled':True},csrf,method='PATCH').status==200
            assert member.request.get(base+'/api/auth/session').status==401
            assert member.request.get(base+'/app.js').status==401
            assert post(member,'/api/auth/login',{'username':test_user,'password':test_password}).status==401
            assert post(admin,f'/api/admin/users/{user_id}',{'disabled':False},csrf,method='PATCH').status==200
            login(member,test_user,test_password)
            assert post(admin,f'/api/admin/users/{user_id}/password',{'password':replacement},csrf).status==200
            assert member.request.get(base+'/api/auth/session').status==401
            assert post(member,'/api/auth/login',{'username':test_user,'password':test_password}).status==401
            member_session=login(member,test_user,replacement)
            passed('Disabling and resetting a user revoke active sessions and invalidate the old password')

            self_new=secrets.token_urlsafe(18)
            assert post(member,'/api/auth/password',{'currentPassword':replacement,'newPassword':self_new},member_session['csrfToken']).status==200
            assert member.request.get(base+'/api/auth/session').status==401
            member_session=login(member,test_user,self_new)
            assert post(member,'/api/auth/logout',None,member_session['csrfToken']).status==200
            assert member.request.get(base+'/api/auth/session').status==401
            passed('Changing a password and logging out revoke sessions on the server')
            member.close()
            assert not report['page_error_types']
        finally:
            if user_id and admin and csrf:
                cleanup=post(admin,f'/api/admin/users/{user_id}',{'disabled':True},csrf,method='PATCH')
                report['synthetic_user_disabled_after_test']=cleanup.status==200
            browser.close()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='https://127.0.0.1:8789')
    parser.add_argument('--report',default=str(ROOT/'tests/NATIVE_AUTH_BROWSER_REPORT.json'))
    args=parser.parse_args()
    report={'base_url':args.base_url,'checks':[],'page_error_types':[], 'credentials_recorded':False}
    try:
        run(args.base_url.rstrip('/'),report)
        report['passed']=True
    except Exception as error:
        report['passed']=False
        report['error_type']=type(error).__name__
        last=traceback.extract_tb(error.__traceback__)[-1]
        report['error_location']={'file':Path(last.filename).name,'line':last.lineno}
    Path(args.report).write_text(json.dumps(report,indent=2)+'\n',encoding='utf8',newline='\n')
    print(json.dumps({'passed':report['passed'],'checks':len(report['checks']),'error_location':report.get('error_location')}))
    raise SystemExit(0 if report['passed'] else 1)
