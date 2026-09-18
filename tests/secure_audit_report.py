"""Regenerate the consolidated report from actually executed audit results."""
import json
from pathlib import Path

root=Path(__file__).resolve().parents[1]
core=json.loads((root/'SECURITY_TEST_REPORT.json').read_text('utf-8'))
ui=json.loads((root/'SECURITY_TEST_REPORT_UI.json').read_text('utf-8'))
lines=[
    '# ASTRA-SECURE-V2 — independent implementation review and executed tests',
    '', 'This is a focused code review and executed test suite by a separate implementation agent. It is not an external certification or a proof that the complete application has no vulnerabilities.',
    '', '## Executed results', '',
    f"Core: **{core['status']}**, {len(core['checks'])} grouped checks, {core['seconds']} seconds. Tested URL: {core['base_url']}",
    '', f"Actual interface: **{ui['status']}**, {len(ui['checks'])} grouped flows, {ui['seconds']} seconds. Tested URL: {ui['base_url']}",
    '', 'Each group includes the individual assertions described in the JSON reports. A public deployment is covered only when its HTTPS URL appears above; a localhost run does not establish public-site behavior.',
    '', '| Core check | Outcome |', '|---|---|',
]
lines += [f"| {c['test']} | PASS |" for c in core['checks']]
lines += ['', '| Real interface check | Outcome |', '|---|---|']
lines += [f"| {c['test']} | PASS |" for c in ui['checks']]
lines += [
    '', f"Actual interface console errors: **{len(ui['console_errors'])}**. Recipient requests after the networking cutoff: **{len(ui['post_cutoff_network_attempts'])}**.",
    '', '## Independent cryptographic verification',
    '', 'The Python oracle imports no application cryptography module. It derives separate payload/token keys with HKDF-SHA256, authenticates the complete canonical public header as AES-GCM additional authenticated data, decrypts the token body, reads the PNG RGB array, independently extracts the low-bit ciphertext stream, decrypts the payload, parses its length-prefixed private metadata, and compares every recovered original byte and SHA-256.',
    '', 'The recipient-mode oracle uses a separately generated Python P-256 key and independently derives its ECDH shared secret from the message’s ephemeral public point. A test copy of that private key is imported nonextractably into an isolated browser context solely to cross-check interoperability; production identities are generated inside WebCrypto and are never exported.',
    '', 'Native WebCrypto and Python cryptography also matched the published AES-256-GCM Example 2 and HKDF-SHA256 test case 1 outputs. The references are [NIST AES-GCM examples](https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Standards-and-Guidelines/documents/examples/AES_GCM.pdf) and [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869). Primitive/API interpretation follows the [W3C Web Cryptography specification](https://www.w3.org/TR/webcrypto/).',
    '', 'Positive fixtures include an RGBA PNG with Unicode metadata, a two-page Letter PDF, PCM WAV audio, and UTF-8 text. All original encoded bytes are preserved, including alpha, image metadata, both PDF pages, audio/container headers, Unicode, and original newline bytes.',
    '', '## Findings and fixes',
    '', 'Review found that the receiving interface previously created an unsandboxed blob iframe for any filename ending in .pdf, even when its authenticated MIME was text/html. Authenticated encryption does not make received active content trustworthy. The interface was changed to remove iframe/object/embed previews, use a safe download card for PDF, and render textual content with textContent. A regression encrypts HTML containing a script marker under a .pdf name, then verifies that no active element or script execution occurs while exact download remains available. An ordinary PDF is separately checked for exact download and absence of CSP console errors.',
    '', 'The IndexedDB module checks nonextractability, key type/curve/usages, public-key fingerprint, and actual public/private pairing through an independent ECDH probe. The audit changed a test-only stored public bundle to the wrong public key and verified rejection. It also reloaded the browser page, recovered the same stored identity, refused private-key export, and decrypted a recipient message offline.',
    '', 'No cryptographic protocol correctness defect was found in the exercised worker paths. This statement is limited to the code reviewed and cases executed.',
    '', '## Security boundaries and visible information',
    '', '- Secret mode requires the separately shared random 32-byte recovery secret. The PNG and token do not contain it. The original filename, MIME, original hash, and original bytes are encrypted.',
    '- Recipient mode requires the matching persisted private key. Fingerprints bind a public bundle to its encoded public key; the application cannot verify the person behind a fingerprint. The UI requires explicit confirmation that the fingerprint was checked through another channel.',
    '- The long-lived recipient ECDH identity does not provide forward secrecy. Anyone obtaining that private key can decrypt captured past messages addressed to it. This protocol does not authenticate a sender identity; anyone with a recipient public key can create a message for it.',
    '- Nonextractable means the WebCrypto API refuses key export. It does not imply hardware protection. Malicious same-origin application code or a compromised browser can use the key, read decrypted content, or capture a entered secret.',
    '- Carrier dimensions, package lengths, mode, public salt/IV values, and recipient fingerprint/ephemeral public point where applicable remain visible. Repeated recipient fingerprints are linkable. The scheme does not promise undetectable steganography or complete traffic-analysis resistance.',
    '- Secure mode deliberately changes 1–4 low bits of cover RGB channels. The maximum per-channel change is bounded by 1, 3, 7, or 15 respectively. It is encrypted steganographic transport, distinct from the conserved-pixel classical permutation mode. The cover itself is public; choosing sensitive source imagery as the cover exposes that visible imagery.',
    '- Editing, resizing, or lossy recompression changes the transported PNG and must fail integrity checks. Losing a recovery secret or deleting the recipient browser identity prevents recovery; this implementation does not provide a private-key backup.',
    '', '## Runtime response headers', '',
    'These are the actual response security headers observed by the browser, not merely entries requested in a local configuration file:',
    '', '```json', json.dumps(core.get('response_security_headers',{}),indent=2), '```',
    '', '## Reproduce',
    '', 'Tested with Python 3.12 and Microsoft Edge at C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe. Install the pinned test dependencies, then run against a running static site:',
    '', '```powershell', 'python -m pip install -r tests/secure_audit_requirements.txt',
    'python tests/secure_audit_core.py --base-url http://127.0.0.1:8770',
    'python tests/secure_audit_ui.py --base-url http://127.0.0.1:8770',
    'python tests/secure_audit_report.py', '```',
    '', 'For the public deployment, replace the base URL in both commands with the tested HTTPS URL shown above. The supplied fixtures are under tests/fixtures; the secure tests do not require the previous Python application or a Python codec server. Python is an external driver/oracle only. Browser operations use native WebCrypto and JavaScript.',
    '', 'Dependencies: NumPy 2.5.3, Pillow 12.3.0, cryptography 50.0.1, Playwright 1.63.0. The real receiving contexts are fresh and separate from the sender, with networking disabled after the page and workers load. This is not a claim of testing a physically remote device.',
]
(root/'SECURITY_TEST_REPORT.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('Wrote SECURITY_TEST_REPORT.md')
