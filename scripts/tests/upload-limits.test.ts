import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createUploadSizeLimiter, exceedsUploadLimit } from '../src/lib/upload-limits.js';

test('upload-url odmítne deklarovaný Content-Length nad 100 MB', () => {
  assert.equal(exceedsUploadLimit(String(100 * 1024 * 1024)), false);
  assert.equal(exceedsUploadLimit(String(100 * 1024 * 1024 + 1)), true);
});

test('upload-url ukončí chunked stream po překročení capu', async () => {
  await assert.rejects(
    pipeline(
      Readable.from([Buffer.alloc(6), Buffer.alloc(5)]),
      createUploadSizeLimiter(10),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    ),
    /limit 0 MB|překročil limit/,
  );
});
