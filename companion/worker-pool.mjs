import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pathModule from 'node:path';

const execFileAsync = promisify(execFile);
const DEFAULT_CAPACITY = 1;
const DEFAULT_CANDIDATES = ['agy', 'agy2', 'agy3'];

/**
 * Descobre os workers AGY configurados ou disponíveis no PATH.
 * @param {{env?: NodeJS.ProcessEnv, path?: string, probe?: Function, config?: object|string, timeoutMs?: number}} options
 * @returns {Promise<Array<{id:string, bin:string, version:string|null, available:boolean, capacity:number}>>}
 */
export async function discoverWorkers(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  if (options.path !== undefined) env.PATH = options.path;
  const config = await loadConfig(options.config);
  const configured = Array.isArray(config?.workers) ? config.workers : [];
  const bins = [];
  const add = (bin, id, capacity) => {
    if (typeof bin !== 'string' || !bin.trim() || bins.some((entry) => entry.bin === bin)) return;
    bins.push({ bin, id: typeof id === 'string' && id.trim() ? id : pathModule.basename(bin), capacity: normalizeCapacity(capacity) });
  };

  if (env.AGY_BIN?.trim()) add(env.AGY_BIN.trim());
  for (const bin of splitBins(env.AGY_POOL_BINS)) add(bin);
  for (const bin of DEFAULT_CANDIDATES) add(bin);
  for (const worker of configured) {
    const existing = bins.find((entry) => entry.bin === worker?.bin);
    if (existing) {
      if (typeof worker.id === 'string' && worker.id.trim()) existing.id = worker.id;
      if (worker.capacity !== undefined) existing.capacity = normalizeCapacity(worker.capacity);
    } else {
      add(worker?.bin, worker?.id, worker?.capacity);
    }
  }

  return Promise.all(bins.map(async (entry) => {
    const result = await probeWorker(entry.bin, { env, timeoutMs: options.timeoutMs, probe: options.probe });
    return { id: entry.id, bin: entry.bin, version: result.version ?? null, available: result.available === true, capacity: entry.capacity };
  }));
}

/**
 * Escolhe um worker respeitando afinidade, capacidade e menor carga.
 * @param {{workers:Array, activeJobs?: object|Array, requestedWorkerId?: string, affinity?: string|{id?:string,bin?:string}}} options
 * @returns {object|null}
 */
export function selectWorker({ workers = [], activeJobs = {}, requestedWorkerId, affinity } = {}) {
  const eligible = workers.filter((worker) => worker?.available === true && loadFor(worker, activeJobs) < normalizeCapacity(worker.capacity));
  if (requestedWorkerId !== undefined) {
    return eligible.find((worker) => worker.id === requestedWorkerId || worker.bin === requestedWorkerId) ?? null;
  }
  if (affinity) {
    const ids = typeof affinity === 'string' ? [affinity] : [affinity.id, affinity.bin].filter(Boolean);
    return eligible.find((worker) => ids.includes(worker.id) || ids.includes(worker.bin)) ?? null;
  }
  return eligible.sort((a, b) => loadFor(a, activeJobs) - loadFor(b, activeJobs))[0] ?? null;
}

async function loadConfig(config) {
  if (!config) return null;
  if (typeof config === 'object') return config;
  try { return JSON.parse(await readFile(config, 'utf8')); } catch { return null; }
}

async function probeWorker(bin, { env, timeoutMs = 1500, probe }) {
  if (probe) {
    try {
      const result = await probe(bin, { env, timeoutMs });
      if (typeof result === 'string') return { available: true, version: result.trim() };
      return { available: result?.available !== false, version: result?.version ?? null };
    } catch { return { available: false, version: null }; }
  }
  try {
    const result = await execFileAsync(bin, ['--version'], { env, timeout: timeoutMs, windowsHide: true });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    return { available: true, version: output.split(/\r?\n/)[0] || null };
  } catch { return { available: false, version: null }; }
}

function splitBins(value) {
  return typeof value === 'string' ? value.split(/[\s,]+/).map((bin) => bin.trim()).filter(Boolean) : [];
}

function normalizeCapacity(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CAPACITY;
}

function loadFor(worker, activeJobs) {
  if (Array.isArray(activeJobs)) return activeJobs.filter((job) => job?.worker?.id === worker.id || job?.worker?.bin === worker.bin).length;
  return Number(activeJobs?.[worker.id] ?? activeJobs?.[worker.bin] ?? 0) || 0;
}
