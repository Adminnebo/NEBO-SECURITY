"""Independent Pillow verification of Node-produced base and portable PNGs."""
import hashlib
import json
from pathlib import Path
import struct
import zlib

from PIL import Image

ROOT = Path(__file__).resolve().parent
ARTIFACTS = ROOT / 'portable_artifacts'
metadata = json.loads((ARTIFACTS / 'metadata.json').read_text())
expected = (ARTIFACTS / 'expected.rgb').read_bytes()
assert hashlib.sha256(expected).hexdigest() == metadata['pixel_sha256']
for name, hash_field in [('base.png', 'base_sha256'), ('portable.png', 'portable_sha256')]:
    data = (ARTIFACTS / name).read_bytes()
    assert hashlib.sha256(data).hexdigest() == metadata[hash_field]
    with Image.open(ARTIFACTS / name) as image:
        image.load()
        assert image.mode == 'RGB'
        assert image.size == (metadata['width'], metadata['height'])
        assert image.tobytes() == expected
    offset, types = 8, []
    while offset < len(data):
        length = struct.unpack_from('>I', data, offset)[0]
        kind = data[offset+4:offset+8]
        crc = struct.unpack_from('>I', data, offset+8+length)[0]
        assert zlib.crc32(data[offset+4:offset+8+length]) & 0xffffffff == crc
        types.append(kind.decode('ascii'))
        offset += length + 12
    assert types == (['IHDR','IDAT','IEND'] if name == 'base.png' else ['IHDR','IDAT','neBo','IEND'])
report = {'status':'PASS','reader':'Pillow','width':metadata['width'],'height':metadata['height'],
          'base_and_portable_rgb_identical':True,'mismatching_pixels':0,
          'standard_png_crcs_verified':True,'pixel_sha256':metadata['pixel_sha256']}
(ROOT / 'PORTABLE_PILLOW_REPORT.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
