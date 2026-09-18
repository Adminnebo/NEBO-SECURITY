"""Build the portable source/test bundle without private test inputs or keys."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent
destination = root.parent / 'ASTRA_WEB_APP_V2.zip'
files = set(path for path in (root / 'public').rglob('*') if path.is_file())
for pattern in ('README.md', 'PRUEBA_ENTRE_DOS_PERSONAS.txt', 'PUBLICACION.json',
                'SECURITY_TEST_REPORT*', 'SECURE_PUBLIC_HEADERS.json',
                'tests/*.py', 'tests/*.mjs', 'tests/*REPORT.json',
                'tests/*requirements*.txt', 'tests/ui-secure/PRIVATE_*.png',
                'tests/ui-secure/SECURE_VISUAL_QA.json', 'package_download.py'):
    files.update(root.glob(pattern))
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
    for path in sorted(files):
        if path.is_file():
            bundle.write(path, Path('ASTRA_WEB') / path.relative_to(root))
with zipfile.ZipFile(destination) as bundle:
    assert bundle.testzip() is None
    names = bundle.namelist()
    assert 'ASTRA_WEB/public/secure-worker.js' in names
    assert not any('/.git/' in name or 'recovery.key' in name or '/fixtures/' in name
                   or '/secure_audit_artifacts/' in name for name in names)
print(json.dumps({'path': str(destination), 'bytes': destination.stat().st_size,
                  'files': len(names), 'zip_integrity_verified': True}))
