import { execFile } from 'node:child_process';
import fs from 'node:fs';
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
  // Dedupe by canonical path, not by the spelling that happened to be used:
  // `AGY_BIN=/usr/local/bin/agy` and the bare `agy` candidate are one worker.
  const add = (bin, id, capacity) => {
    const key = canonicalBin(bin, env);
    if (key === null || bins.some((entry) => entry.key === key)) return;
    bins.push({ bin, key, id: typeof id === 'string' && id.trim() ? id : pathModule.basename(bin), capacity: normalizeCapacity(capacity) });
  };

  if (env.AGY_BIN?.trim()) add(env.AGY_BIN.trim());
  for (const bin of splitBins(env.AGY_POOL_BINS)) add(bin);
  for (const bin of DEFAULT_CANDIDATES) add(bin);
  for (const worker of configured) {
    const key = canonicalBin(worker?.bin, env);
    const existing = key === null ? undefined : bins.find((entry) => entry.key === key);
    if (existing) {
      if (typeof worker.id === 'string' && worker.id.trim()) existing.id = worker.id;
      if (worker.capacity !== undefined) existing.capacity = normalizeCapacity(worker.capacity);
    } else {
      add(worker?.bin, worker?.id, worker?.capacity);
    }
  }
  disambiguateIds(bins);

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
  const fits = (worker) => worker?.available === true && loadFor(worker, activeJobs) < normalizeCapacity(worker.capacity);
  // Identity is resolved over the whole pool, then eligibility is checked.
  // Filtering first made a named worker that is merely busy fall through to a
  // namesake — a silent migration, and the very thing affinity exists to stop.
  if (requestedWorkerId !== undefined || affinity) {
    const target = matchWorker(workers, affinityTarget(requestedWorkerId ?? affinity));
    return target && fits(target) ? target : null;
  }
  return workers.filter(fits).sort((a, b) => loadFor(a, activeJobs) - loadFor(b, activeJobs))[0] ?? null;
}

/**
 * Escolhe o worker E regista o job, contra um único snapshot de estado.
 *
 * A descoberta é lenta e assíncrona; a escolha é instantânea. Separá-las
 * permite sondar cedo e correr esta função dentro do mesmo lock que escreve o
 * registo do job — é isso que fecha a janela em que dois dispatches
 * `--worker auto` simultâneos liam a pool ainda ociosa e ficavam ambos com o
 * mesmo worker de capacidade 1: aqui o primeiro registo já faz parte de
 * `state` quando o segundo calcula a carga.
 *
 * `pinned` ignora a seleção (worker legacy ou afinidade fora da pool) mas
 * regista na mesma, para que todo o registo passe por um único caminho.
 * Lança um erro etiquetado quando nada é elegível; quem chama é que reporta.
 *
 * @param {{jobs?: Array}} state estado mutável lido sob o lock de registo
 * @returns {{id:string, bin:string, version:string|null, capacity:number}}
 */
export function reserveWorker(state, { pinned, workers = [], requestedWorkerId, affinity, isRunning = () => true, job } = {}) {
  state.jobs ||= [];
  let selected = pinned;
  if (!selected) {
    const activeJobs = state.jobs.filter((record) => isRunning(record));
    const worker = selectWorker({ workers, activeJobs, requestedWorkerId, affinity });
    if (!worker) throw poolUnavailable({ workers, activeJobs, requestedWorkerId, affinity });
    selected = { id: worker.id, bin: worker.bin, version: worker.version ?? null, capacity: normalizeCapacity(worker.capacity) };
  }
  if (job) {
    job.worker = selected;
    state.jobs.push(job);
  }
  return selected;
}

/**
 * "Ocupado" e "desaparecido" pedem ações diferentes a quem chama. Reportar um
 * worker ocupado como indisponível deixava `restart <job>` sem saída nenhuma:
 * o worker afim recusava por "indisponível" e qualquer outro batia no conflito
 * de afinidade.
 */
function poolUnavailable({ workers, activeJobs, requestedWorkerId, affinity }) {
  if (affinity) {
    const target = affinityTarget(affinity);
    const label = target.ids[0] ?? target.bins[0] ?? 'unknown';
    const worker = matchWorker(workers, target);
    if (worker?.available === true) {
      const capacity = normalizeCapacity(worker.capacity);
      return tagged(
        `worker ${label} for this job is busy (${loadFor(worker, activeJobs)}/${capacity} active jobs); refusing automatic migration — ` +
          'wait for it to finish, cancel one of its jobs, or raise its capacity in the pool config',
        'worker_busy'
      );
    }
    return tagged(`worker ${label} for this job is unavailable; refusing automatic migration`, 'worker_unavailable');
  }
  if (requestedWorkerId !== undefined) {
    return tagged(`worker "${requestedWorkerId}" is unavailable or at capacity`, 'worker_unavailable');
  }
  return tagged('no available AGY worker found', 'no_worker');
}

function tagged(message, reason) {
  return Object.assign(new Error(message), { reason });
}

/** A `--worker <id>` string may name either column; a stored affinity keeps its
 *  two columns apart, so an id never matches some other worker's executable. */
function affinityTarget(affinity) {
  if (typeof affinity === 'string') return { ids: [affinity], bins: [affinity] };
  return { ids: [affinity.id].filter(Boolean), bins: [affinity.bin].filter(Boolean) };
}

/** Id wins over executable: it is what `--worker` and the job record address. */
function matchWorker(workers, { ids, bins }) {
  return workers.find((worker) => ids.includes(worker.id)) ?? workers.find((worker) => bins.includes(worker.bin)) ?? null;
}

/**
 * Caminho canónico usado só para decidir se dois bins são o mesmo executável.
 *
 * Um nome nu é procurado no PATH, para que `AGY_BIN=/usr/local/bin/agy` e o
 * candidato `agy` colapsem num worker em vez de entrarem duas vezes com o
 * mesmo id — o que tornava `--worker agy` ambíguo, contava um job contra as
 * duas linhas e duplicava a capacidade real da pool.
 *
 * Symlinks NÃO são resolvidos de propósito: vários links para um mesmo
 * executável agy são uma forma suportada de correr vários workers, por isso
 * têm de continuar distintos.
 */
function canonicalBin(bin, env) {
  if (typeof bin !== 'string' || !bin.trim()) return null;
  const value = bin.trim();
  if (value.includes('/') || value.includes(pathModule.sep)) return pathModule.resolve(value);
  return lookupOnPath(value, env) ?? value;
}

function lookupOnPath(name, env) {
  const dirs = String(env?.PATH ?? '').split(pathModule.delimiter).filter(Boolean);
  // On Windows the PATH entry is only executable together with a PATHEXT
  // suffix; '' first covers a name that already carries its extension.
  const extensions = process.platform === 'win32'
    ? ['', ...String(env?.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = pathModule.resolve(dir, name + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* absent or not executable here: keep looking */ }
    }
  }
  return null;
}

/** Dois executáveis diferentes podem partilhar o basename (…/a/agy e …/b/agy).
 *  O id endereça o worker na linha de comandos, por isso não pode colidir. */
function disambiguateIds(bins) {
  const taken = new Set();
  for (const entry of bins) {
    let id = entry.id;
    for (let n = 2; taken.has(id); n++) id = `${entry.id}-${n}`;
    entry.id = id;
    taken.add(id);
  }
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
