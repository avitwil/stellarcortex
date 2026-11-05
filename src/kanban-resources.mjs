import os from 'node:os';
// Actual host counters; admission is advisory, not process/VM isolation.
// Free telemetry and reservation headroom are intersected, never subtracted twice.
export function createHostResourceSampler({
  cpus = () => os.cpus(),
  parallelism = () => os.availableParallelism(),
  freeMemory = () => os.freemem(),
  totalMemory = () => os.totalmem(),
  clock = () => performance.now(),
} = {}) {
  const counters = () =>
    cpus().reduce(
      (sum, cpu) => {
        const values = Object.values(cpu.times);
        return {
          idle: sum.idle + cpu.times.idle,
          total: sum.total + values.reduce((a, b) => a + b, 0),
        };
      },
      { idle: 0, total: 0 },
    );
  let previous = counters(),
    at = clock(),
    idleFraction = null;
  return () => {
    const current = counters(),
      time = clock(),
      elapsed = time - at;
    if (elapsed >= 100) {
      const total = current.total - previous.total,
        idle = current.idle - previous.idle;
      idleFraction = total > 0 && idle >= 0 ? Math.min(1, idle / total) : null;
      previous = current;
      at = time;
    }
    const totalCores = parallelism(),
      memory = freeMemory(),
      total = totalMemory();
    return {
      cores: idleFraction === null ? 0 : totalCores * idleFraction,
      memory,
      totalCores,
      totalMemory: total,
      cpuMeasured: idleFraction !== null,
      sampledAt: time,
      source: 'host-cpu-time-and-memory',
    };
  };
}
