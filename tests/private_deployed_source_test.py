"""Compare deployed private resources to this checkout using an owner QA header.

Reads an existing owner credential from stdin only. Does not automate OAuth or
create a session. Never logs the credential or records it in the report.
"""
import hashlib
import json
from pathlib import Path
import sys
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://astra-pixel-mensajes-lucas.lucasarmando417.chatgpt.site'
PATHS = ['access.js', 'access-check.json', 'app.js', 'sw.js', 'install.js',
         'manifest.webmanifest', 'secure-worker.js', 'portable-png.js']


def main():
    token = sys.stdin.read().strip()
    if not token:
        raise SystemExit('Provide the existing owner QA credential on stdin.')
    opener = build_opener(NoRedirect())
    report = {'base_url':BASE, 'version_number':10,
              'commit_sha':'9ab7809805b3ac2a31d4dce797424351110722b7',
              'scope':'Authorized source delivery and byte equality only; not OAuth or live browser flow.',
              'credential_recorded':False, 'redirects_followed':False, 'checks':[]}
    for name in PATHS:
        check = {'path':'/' + name, 'passed':False}
        try:
            request = Request(BASE + '/' + name,
                              headers={'OAI-Sites-Authorization':'Bearer ' + token,
                                       'Cache-Control':'no-cache'})
            with opener.open(request, timeout=30) as response:
                data = response.read()
                expected = (ROOT / 'public' / name).read_bytes()
                check.update(status=response.status, bytes=len(data),
                             sha256=hashlib.sha256(data).hexdigest(),
                             passed=response.status == 200 and data == expected)
        except Exception as error:
            check['error_type'] = type(error).__name__
        report['checks'].append(check)
        print(json.dumps(check), flush=True)
    report['passed'] = all(check['passed'] for check in report['checks'])
    (ROOT / 'tests/PRIVATE_DEPLOYED_SOURCE_REPORT.json').write_text(
        json.dumps(report, indent=2) + '\n', encoding='utf-8', newline='\n')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
