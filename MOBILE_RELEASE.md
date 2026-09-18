# ASTRA mobile interface — published version 3

Public app: https://astra-pixel-mensajes-lucas.lucasarmando417.chatgpt.site

The mobile interface presents File → Cover → Share as separate steps. A fixed
bottom bar keeps the main action and receive/send navigation within reach.
Additional settings are collapsed. Main touch controls are at least 44 px and
text inputs use at least 16 px. Errors are scrolled above the action bar.

The cryptographic workers and transport formats are unchanged. Native sharing,
when the browser permits it, contains only the PNG and encrypted token. The
secret is never included. Individual downloads remain available.

## Executed checks

- Local: all seven grouped checks passed with no browser errors.
- Public: all seven functional groups passed at 360, 390, 430 and 1440 px.
- Actual downloads and fresh offline recipients recovered identical bytes and
  filenames. No receiver network requests occurred after the offline cutoff.
- Draft/result state survived navigation, the wrong-key error stayed visible,
  and no horizontal page overflow was measured.
- Native share contents were checked with a local API stub; no files were sent
  to an external person and no physical phone share sheet was exercised.

The public suite's strict zero-console-errors check returned FAIL because the
host injects an inline challenge-platform script that the page's CSP blocks.
The raw report is preserved, including every message. There were no JavaScript
page exceptions or failed functional groups. The CSP was not weakened.

A separate read-only browser inspection confirmed an inline script referencing
`/cdn-cgi/challenge-platform/`. Its SHA-256 was
`tgADIv3GgmIaB0DnW65jor4L0Pdcd7Ye4cLYMhmWbIA=` and exactly matched that visit's
CSP console rejection. This identifies the observed host-script conflict; it
does not certify all future injected scripts. Version 2 already documented
the hosting/CSP limitation.

See `MOBILE_UX_REPORT.json` for the production evidence and
`tests/mobile-ui/MOBILE_UX_REPORT_LOCAL.json` for the clean local run.
Tests used Microsoft Edge with emulated phone viewports, not physical phones.

## Repeat

```powershell
python tests/mobile_ux_test.py --base-url https://astra-pixel-mensajes-lucas.lucasarmando417.chatgpt.site --label public
```

The strict console check may again flag the hosting script described above.
