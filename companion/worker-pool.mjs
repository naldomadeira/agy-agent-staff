import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pathModule from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const DEFAULT_CAPACITY = 1;
const DEFAULT_CANDIDATES = ['agy', 'agy2', 'agy3'];
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_RETRY_TIMEOUT_MS = 5000;
const DEFAULT_QUOTA_CACHE_DIR = pathModule.join(os.homedir(), '.codex-profiles', 'cache');

/** A positive millisecond count from the environment, or null. Anything else
 *  — empty, zero, negative, not a number — is ignored rather than obeyed: a
 *  typo that silently set the probe timeout to zero would mark every worker
 *  `unknown`, which is worse than the default it replaced. */
function envTimeout(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Descobre os workers AGY configurados ou disponíveis no PATH.
 *
 * `quotaSlack` e `quotaAgeMs` vêm de uma leitura de disco feita por um hook
 * externo (ver `readQuota`), não deste processo — por isso podem faltar
 * (`null`) sem que isso seja um erro: um worker sem ficheiro de quota
 * correspondente simplesmente não participa do desempate por folga.
 *
 * @param {{env?: NodeJS.ProcessEnv, path?: string, probe?: Function, config?: object|string, timeoutMs?: number, retryTimeoutMs?: number, now?: number}} options
 * @returns {Promise<Array<{id:string, bin:string, version:string|null, available:boolean, status:'available'|'unavailable'|'unknown', capacity:number, quotaSlack:number|null, quotaAgeMs:number|null}>>}
 */
export async function discoverWorkers(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  if (options.path !== undefined) env.PATH = options.path;
  const now = options.now ?? Date.now();
  const quotaCacheDir = env.AGY_QUOTA_CACHE_DIR?.trim() || DEFAULT_QUOTA_CACHE_DIR;
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
    const result = await probeWorker(entry.bin, {
      env,
      // Explicit options win; the environment is the escape hatch for a
      // machine where the wrappers are genuinely slower than the defaults.
      timeoutMs: options.timeoutMs ?? envTimeout(env.AGY_PROBE_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
      retryTimeoutMs:
        options.retryTimeoutMs ?? envTimeout(env.AGY_PROBE_RETRY_TIMEOUT_MS) ?? DEFAULT_RETRY_TIMEOUT_MS,
      probe: options.probe,
    });
    const quota = await readQuota(quotaCacheDir, entry.bin, now);
    return {
      id: entry.id,
      bin: entry.bin,
      version: result.version ?? null,
      available: result.status === 'available',
      status: result.status,
      capacity: entry.capacity,
      quotaSlack: quota ? quota.slack : null,
      quotaAgeMs: quota ? quota.ageMs : null,
    };
  }));
}

/**
 * Escolhe um worker respeitando afinidade, capacidade e menor carga.
 * @param {{workers:Array, activeJobs?: object|Array, requestedWorkerId?: string, affinity?: string|{id?:string,bin?:string}}} options
 * @returns {object|null}
 */
export function selectWorker({ workers = [], activeJobs = {}, requestedWorkerId, affinity } = {}) {
  const withinCapacity = (worker) => loadFor(worker, activeJobs) < normalizeCapacity(worker.capacity);
  // A worker that exists but never answered the probe in time (`status:
  // 'unknown'`) is not risked on a blind `auto` dispatch, but it is exactly
  // what an operator naming `--worker <id>` explicitly is asking for.
  const reachable = (worker) => worker?.available === true || worker?.status === 'unknown';
  // Identity is resolved over the whole pool, then eligibility is checked.
  // Filtering first made a named worker that is merely busy fall through to a
  // namesake — a silent migration, and the very thing affinity exists to stop.
  if (requestedWorkerId !== undefined || affinity) {
    const target = matchWorker(workers, affinityTarget(requestedWorkerId ?? affinity));
    return target && reachable(target) && withinCapacity(target) ? target : null;
  }
  // Among workers confirmed available, more quota slack wins. Slack unknown
  // on both sides, or tied (including two workers both at 0%), falls back to
  // the older least-load rule, so a missing quota cache never blocks the pool.
  return workers
    .filter((worker) => worker.available === true && withinCapacity(worker))
    .sort((a, b) => bySlack(a, b) || loadFor(a, activeJobs) - loadFor(b, activeJobs))[0] ?? null;
}

/**
 * Ordena por folga, e trata "desconhecida" como pior do que qualquer folga
 * medida.
 *
 * Desconhecida não quer dizer cheia: pode ser um worker sem ficheiro de quota,
 * ou um cujas janelas reiniciaram todas — e esse último até é provavelmente o
 * mais livre de todos. Mesmo assim perde para um número medido, porque
 * "provavelmente livre" não é "livre" e `auto` escolhe sozinho, sem ninguém
 * a confirmar o palpite. Quando nada é conhecido, ninguém ganha aqui e a
 * decisão cai na carga, como antes de existir quota nenhuma.
 */
function bySlack(a, b) {
  const known = (worker) => typeof worker.quotaSlack === 'number';
  if (known(a) !== known(b)) return known(a) ? -1 : 1;
  if (!known(a)) return 0;
  return b.quotaSlack - a.quotaSlack;
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
    if (worker && (worker.available === true || worker.status === 'unknown')) {
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

/**
 * Sonda um binário e devolve um estado de três valores, não um booleano.
 *
 * A primeira tentativa usa `timeoutMs` (1500ms por omissão) — apertado de
 * propósito, para não segurar `discoverWorkers` por um worker parado. Um
 * ENOENT/ENOTDIR/EACCES/EPERM é final: o binário não existe ou não é
 * executável, e mais tempo não muda isso. Um timeout é outra coisa — o
 * wrapper `agy2`..`agy5` arranca Python e provisiona keychain na primeira
 * corrida, e 1500ms passam com facilidade sem que o binário esteja avariado
 * — por isso ganha uma segunda tentativa, mais folgada (`retryTimeoutMs`,
 * 5000ms por omissão). Só se essa segunda tentativa TAMBÉM expirar é que o
 * resultado é `'unknown'`: existe, mas não respondeu a tempo nenhuma vez.
 *
 * @returns {Promise<{status:'available'|'unavailable'|'unknown', version:string|null}>}
 */
async function probeWorker(bin, { env, timeoutMs = DEFAULT_TIMEOUT_MS, retryTimeoutMs = DEFAULT_RETRY_TIMEOUT_MS, probe }) {
  const attempt = (ms) => (probe ? probeOnce(bin, { env, timeoutMs: ms, probe }) : execProbeOnce(bin, { env, timeoutMs: ms }));

  const first = await attempt(timeoutMs);
  if (first.status !== 'retry') return first;

  const second = await attempt(retryTimeoutMs);
  if (second.status === 'retry') return { status: 'unknown', version: null };
  return second;
}

async function probeOnce(bin, { env, timeoutMs, probe }) {
  try {
    const result = await probe(bin, { env, timeoutMs });
    if (typeof result === 'string') return { status: 'available', version: result.trim() };
    return { status: result?.available === false ? 'unavailable' : 'available', version: result?.version ?? null };
  } catch (error) {
    return classifyProbeError(error);
  }
}

async function execProbeOnce(bin, { env, timeoutMs }) {
  try {
    const result = await execFileAsync(bin, ['--version'], { env, timeout: timeoutMs, windowsHide: true });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    return { status: 'available', version: output.split(/\r?\n/)[0] || null };
  } catch (error) {
    return classifyProbeError(error);
  }
}

/**
 * `execFile`'s timeout kills the child and surfaces as `killed: true` and/or
 * `signal: 'SIGTERM'` on the rejected error — NOT as a system-error `code`
 * (that field is `null` on a timeout kill; confirmed by running `execFile`
 * against a process that outlives its timeout). Any other error (ENOENT,
 * ENOTDIR, EACCES, EPERM, or anything unrecognized) is treated as final and
 * true: the binary is not there or not runnable, and a retry would not help.
 */
function classifyProbeError(error) {
  const isTimeout = error?.killed === true || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT';
  if (isTimeout) return { status: 'retry' };
  return { status: 'unavailable', version: null };
}

/**
 * Lê a folga de quota já capturada em disco por um hook externo — este
 * processo nunca escreve aqui. `bin` é mapeado para o nome de perfil pelo
 * nome do executável (`agy` → `principal`, `agy2`..`agyN` → `profile2`..
 * `profileN`), não por uma lista fixa: um worker cujo nome não bate com este
 * padrão, ou cujo ficheiro não existe, simplesmente não tem folga — e isso
 * não é erro, tal como um JSON corrompido não é erro.
 *
 * @returns {Promise<{slack:number, ageMs:number}|null>}
 */
async function readQuota(cacheDir, bin, now) {
  const profile = quotaProfileForBin(bin);
  if (!profile) return null;
  const file = pathModule.join(cacheDir, `agy-quota-${profile}.json`);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const capturedAt = Number(data?.captured_at);
  if (!Number.isFinite(capturedAt)) return null;
  const slack = slackFrom(data, now);
  if (slack === null) return null;
  return { slack, ageMs: Math.max(0, now - capturedAt * 1000) };
}

/**
 * A folga a partir de uma leitura de quota, ignorando janelas que já
 * reiniciaram.
 *
 * Um `used_percent` só vale enquanto a janela que o contou ainda estiver a
 * correr. Depois do `resets_at` o contador esvaziou-se e o número guardado
 * passa a descrever um passado que já não conta — ler uma captura de há 11h
 * e anunciar "17% de folga" quando a janela de 5h virou entretanto é dizer
 * uma coisa falsa com cara de facto. Aconteceu.
 *
 * As janelas são independentes (5h e 7 dias apertam separadamente), por isso
 * a regra é por janela: descarta as que reiniciaram, e a folga sai da mais
 * apertada das que restam.
 *
 * Se TODAS reiniciaram, a resposta é `null` — desconhecida — e não 100%.
 * Um contador esvaziado sugere que a conta está livre, mas "provavelmente
 * livre" não é "livre", e devolver 100% punha um worker sobre o qual não se
 * sabe nada à frente de outro com leitura fresca e folga real.
 */
function slackFrom(data, now) {
  const buckets = data?.buckets && typeof data.buckets === 'object'
    ? Object.values(data.buckets)
    : [{ used_percent: data?.used_percent, resets_at: data?.resets_at }];
  const live = buckets
    .filter((bucket) => {
      const resetsAt = Number(bucket?.resets_at);
      // Sem `resets_at` não há como saber se a janela virou; conta na mesma,
      // porque descartar uma leitura por lhe faltar um campo opcional seria
      // trocar um número conservador por nenhum.
      return !Number.isFinite(resetsAt) || resetsAt * 1000 > now;
    })
    .map((bucket) => Number(bucket?.used_percent))
    .filter((used) => Number.isFinite(used));
  if (!live.length) return null;
  return Math.max(0, Math.min(100, 100 - Math.max(...live)));
}

/** `agy` is `principal`; `agy2`..`agy5` are `profile2`..`profile5`. Derived
 *  from the executable's basename so a worker at a custom path or with a
 *  configured id still resolves, and a name that does not fit the pattern
 *  (e.g. `/opt/agy-primary`) correctly has no quota file to find. */
function quotaProfileForBin(bin) {
  if (typeof bin !== 'string') return null;
  const base = pathModule.basename(bin).replace(/\.(exe|cmd|bat|com)$/i, '');
  const match = base.match(/^agy(\d*)$/);
  if (!match) return null;
  return match[1] === '' ? 'principal' : `profile${match[1]}`;
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
