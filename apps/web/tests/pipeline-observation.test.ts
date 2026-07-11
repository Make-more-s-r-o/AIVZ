import { strict as assert } from 'node:assert';
import test from 'node:test';

import { pipelineObservationKey } from '../src/lib/pipeline-observation.js';

test('resume stejného parent jobu vytvoří novou observaci změnou stavu', () => {
  const waiting = pipelineObservationKey({ jobId: 'parent-1', status: 'waiting_approval' });
  const running = pipelineObservationKey({ jobId: 'parent-1', status: 'running' });
  assert.notEqual(waiting, running);
});
