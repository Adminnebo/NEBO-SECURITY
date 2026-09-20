import assert from 'node:assert/strict';
import { planCover } from '../public/cover-planner.js';
for (const bytes of [0, 100, 65536, 1024*1024, 5*1024*1024, 10*1024*1024, 20*1024*1024+8192+20]) {
  const plan = planCover({ ciphertextBytes: bytes });
  assert(plan.width <= 4096 && plan.height <= 4096 && plan.bits <= 4);
  assert(plan.width*plan.height*3*plan.bits >= bytes*8);
  assert(plan.maxPngBytes > (plan.width*3+1)*plan.height);
}
assert.equal(planCover({ciphertextBytes:100}).width,1024);
assert.equal(planCover({ciphertextBytes:20*1024*1024+8192+20}).format,'square');
assert.equal(planCover({ciphertextBytes:100,format:'portrait',resolution:2048}).height,2048);
assert.throws(()=>planCover({ciphertextBytes:20*1024*1024,format:'landscape',resolution:2048}),/no cabe/);
assert.throws(()=>planCover({ciphertextBytes:-1}));
assert.throws(()=>planCover({format:'bogus'}));
assert.throws(()=>planCover({resolution:NaN}));
console.log('PASS: auto and manual capacity, maximum payload, dimensions, upper bound and invalid input.');
