import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostResourceSampler } from '../src/kanban-resources.mjs';
test('host sampler uses CPU time deltas and measured free RAM, not load-average or bot counts', () => {
  let time = 0,
    idle = 100,
    totalBusy = 100;
  const sample = createHostResourceSampler({
    clock: () => time,
    cpus: () => [{ times: { idle, user: totalBusy } }],
    parallelism: () => 4,
    freeMemory: () => 1234,
    totalMemory: () => 5000,
  });
  assert.equal(sample().cpuMeasured, false);
  time = 100;
  idle += 75;
  totalBusy += 25;
  const r = sample();
  assert.equal(r.cores, 3);
  assert.equal(r.totalCores, 4);
  assert.equal(r.memory, 1234);
  assert.equal(r.totalMemory, 5000);
  time = 200;
  idle += 0;
  totalBusy += 100;
  assert.equal(sample().cores, 0);
});
