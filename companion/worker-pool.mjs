import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pathModule from 'node:path';
import os from 'node:os';
import { agyLaunch } from './agy-launch.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_CAPACITY = 1;
const DEFAULT_CANDIDATES = ['agy', 'agy2', 'agy3'];
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_RETRY_TIMEOUT_MS = 5000;
const DEFAULT_QUOTA_CACHE_DIR = pathModule.join(os.homedir(), '.codex-profiles', 'cache');
const MAX_QUOTA_AGE_MS = 6 * 60 * 60 * 1000;
// Numbered profiles beyond agy3 are looked up on PATH up to this number. A
// 10-account pool used to lose agy8..agy10 silently, because the scan stopped
// at agy7 and `--worker agy9` then failed as if the worker were busy.
const DEFAULT_MAX_PROFILE = 20;
// A window this full leaves less than a job's worth of quota.
const BLOCKED_PERCENT = 95;

export function quotaPoolForModel(model) {
  if (!model) return null;
  return model.startsWith('gemini-') ? 'gemini' : '3p';
}

/** Below this slack a pool counts as closed for routing: a job would start
 *  and die minutes in, burning the account's window for nothing. */
export const OPEN_SLACK_PERCENT = 5;

/** The measured slack of `model`'s pool on `worker`, or null when unknown. */
export function slackForModel(worker, model) {
  const value = quotaPoolForModel(model) === 'gemini' ? worker.quotaGemini : worker.quotaThirdParty;
  return typeof value === 'number' ? value : null;
}

/**
 * Escolhe modelo E worker a partir de uma cadeia de preferência.
 *
 * Percorre `chain` por ordem; para cada modelo, só conta um worker com
 * leitura medida e folga aberta no pool desse modelo (`OPEN_SLACK_PERCENT`).
 * Folga desconhecida não entra: `auto` existe para não despachar às cegas, e
 * um palpite foi exatamente o que gastou oito despachos num dia. O primeiro
 * modelo com algum worker elegível ganha; dentro dele, `selectWorker` decide
 * por folga e carga. `exclude` tira pares (worker, pool) que já morreram de
 * quota neste job, mesmo que o cache ainda não o saiba.
 *
 * @returns {{worker:object, model:string}|null}
 */
export function routeWorker({ workers = [], chain = [], activeJobs = {}, requestedWorkerId, exclude = [] } = {}) {
  const excluded = (worker, model) => exclude.some((entry) =>
    (entry.id === worker.id || entry.bin === worker.bin) && entry.pool === quotaPoolForModel(model));
  for (const model of chain) {
    const candidates = workers
      .filter((worker) => !excluded(worker, model))
      .filter((worker) => (slackForModel(worker, model) ?? -1) >= OPEN_SLACK_PERCENT)
      .map((worker) => ({ ...worker, quotaSlack: slackForModel(worker, model) }));
    const worker = selectWorker({ workers: candidates, activeJobs, requestedWorkerId });
    if (worker) return { worker: workers.find((entry) => entry.id === worker.id) ?? worker, model };
  }
  return null;
}

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
 * @param {{env?: NodeJS.ProcessEnv, path?: string, probe?: Function, config?: object|string, timeoutMs?: number, retryTimeoutMs?: number, now?: number, model?: string}} options
 * @returns {Promise<Array<{id:string, bin:string, version:string|null, available:boolean, status:'available'|'unavailable'|'unknown', capacity:number, quotaSlack:number|null, quotaAgeMs:number|null}>>}
 */
export async function discoverWorkers(options = {}) {
  // `options.env`, when given, is the WHOLE environment discovery sees — it is
  // not layered on top of process.env. A test that hands in `{}` means "no
  // vars, full stop"; merging process.env underneath would let the host shell
  // (AGY_POOL_BINS, AGY_BIN, …) leak into results the test thinks it controls.
  // Every production caller omits `options.env`, so this changes nothing for
  // the CLI: it still reads the real process.env.
  const env = options.env !== undefined ? { ...options.env } : { ...process.env };
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
  // Additional local profiles are optional; show them only when present.
  const maxProfile = Number.parseInt(env.AGY_POOL_MAX_PROFILE, 10) > 3
    ? Number.parseInt(env.AGY_POOL_MAX_PROFILE, 10) : DEFAULT_MAX_PROFILE;
  for (let number = 4; number <= maxProfile; number++) {
    const name = `agy${number}`;
    if (lookupOnPath(name, env)) add(name);
  }
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
    const quota = await readQuota(quotaCacheDir, entry.bin, now, options.model);
    return {
      id: entry.id,
      bin: entry.bin,
      version: result.version ?? null,
      available: result.status === 'available',
      status: result.status,
      capacity: entry.capacity,
      quotaSlack: quota ? quota.slack : null,
      quotaAgeMs: quota ? quota.ageMs : null,
      quotaGemini: quota ? quota.gemini : null,
      quotaThirdParty: quota ? quota.thirdParty : null,
      quotaResetGemini: quota ? quota.resetGemini : null,
      quotaResetThirdParty: quota ? quota.resetThirdParty : null,
    };
  }));
}

export const PROBE_MODEL = 'gemini-3.8-flash-low';
export const DEFAULT_PROBE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Refresca a leitura de quota dos workers cuja leitura está velha.
 *
 * Não há forma de perguntar a quota a uma conta sem a pôr a correr: o
 * endpoint vive dentro do language server que o próprio agy arranca, e o
 * hook de status line só escreve o cache enquanto o agy corre. Por isso a
 * sonda é um turno mínimo (`gemini-3.8-flash-low`, sem ferramentas, uns
 * 9 s) que gasta um resto do pool gemini e faz o hook regravar o cache com as
 * janelas e o `disabled` atuais. Só corre nas contas com leitura ausente ou
 * mais velha do que `maxAgeMs`, todas em paralelo, numa pasta temporária.
 *
 * @returns {Promise<Array<{id:string, ok:boolean, ms:number, error?:string}>>}
 */
export async function refreshQuota(workers, { env = process.env, maxAgeMs = DEFAULT_PROBE_MAX_AGE_MS, timeoutMs = 60000, ping, lockDir = os.tmpdir() } = {}) {
  const stale = workers.filter((worker) =>
    worker.status !== 'unavailable' && (typeof worker.quotaAgeMs !== 'number' || worker.quotaAgeMs >= maxAgeMs));
  const run = ping ?? pingWorker;
  return Promise.all(stale.map(async (worker) => {
    const started = Date.now();
    // Ten parallel `--model auto` dispatches would otherwise ping every
    // stale account ten times. The first one takes a short-lived lock; the
    // rest skip that account and read whatever the first one refreshed.
    const release = probeLock(lockDir, worker, timeoutMs + 10000);
    if (!release) return { id: worker.id, ok: true, ms: 0, skipped: 'probe already running' };
    try {
      await run(worker.bin, { env, timeoutMs });
      return { id: worker.id, ok: true, ms: Date.now() - started };
    } catch (error) {
      const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}${error?.message ?? ''}`;
      // An exhausted gemini pool still answers with its quota, and the hook
      // has recorded it by the time the error surfaces: that is a reading.
      const exhausted = /RESOURCE_EXHAUSTED|quota/i.test(text);
      return { id: worker.id, ok: exhausted, ms: Date.now() - started, error: exhausted ? 'quota_exhausted' : firstLine(text) };
    } finally {
      release();
    }
  }));
}

function probeLock(dir, worker, staleMs) {
  const name = `agy-staff-probe-${String(worker.id).replace(/[^\w.-]/g, '_')}.lock`;
  const file = pathModule.join(dir, name);
  const take = () => {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
  };
  try {
    return take();
  } catch {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < staleMs) return null;
      fs.unlinkSync(file);
      return take();
    } catch {
      return null;
    }
  }
}

async function pingWorker(bin, { env, timeoutMs }) {
  const cwd = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'agy-probe-'));
  try {
    const agy = agyLaunch(bin, ['-p', 'Reply with the single word: ok', '--model', PROBE_MODEL,
      '--output-format', 'json', '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`]);
    await execFileAsync(agy.cmd, agy.args, { env, cwd, timeout: timeoutMs + 5000, windowsHide: true });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function firstLine(text) {
  return String(text).trim().split(/\r?\n/)[0]?.slice(0, 200) || 'probe failed';
}

/**
 * Escolhe um worker respeitando afinidade, capacidade e menor carga.
 * @param {{workers:Array, activeJobs?: object|Array, requestedWorkerId?: string, affinity?: string|{id?:string,bin?:string}}} options
 * @returns {object|null}
 */
export function selectWorker({ workers = [], activeJobs = {}, requestedWorkerId, affinity } = {}) {
  const withinCapacity = (worker) => loadFor(worker, activeJobs) < normalizeCapacity(worker.capacity);
  // `unknown` is a worker that exists and did not answer the probe in time,
  // not even on the retry. It counts as reachable — for an explicit
  // `--worker <id>` and for `auto` alike.
  const reachable = (worker) => worker?.available === true || worker?.status === 'unknown';
  // Identity is resolved over the whole pool, then eligibility is checked.
  // Filtering first made a named worker that is merely busy fall through to a
  // namesake — a silent migration, and the very thing affinity exists to stop.
  if (requestedWorkerId !== undefined || affinity) {
    const target = matchWorker(workers, affinityTarget(requestedWorkerId ?? affinity));
    return target && reachable(target) && withinCapacity(target) ? target : null;
  }
  // Order: workers that answered the probe first, then `unknown`; within each
  // group, more quota slack wins, and load breaks the tie.
  //
  // `unknown` is eligible for `auto`, ranked last. Excluding it looked prudent
  // and was not: the reason that state exists at all is a false negative that
  // left two good profiles unused, and refusing them in `auto` repeats the
  // same waste by another route — it turns "not there" into "there, but not
  // counted on". A dispatch to a worker that turns out to be dead fails fast
  // and loudly; idle capacity never fails, which is why nobody sees it.
  return workers
    .filter((worker) => reachable(worker) && withinCapacity(worker))
    .sort(
      (a, b) => byProbe(a, b) || bySlack(a, b) || loadFor(a, activeJobs) - loadFor(b, activeJobs),
    )[0] ?? null;
}

/** A worker that answered the probe comes before one that did not. */
function byProbe(a, b) {
  const rank = (worker) => (worker?.available === true ? 0 : 1);
  return rank(a) - rank(b);
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
    const worker = matchWorker(workers, affinityTarget(requestedWorkerId));
    if (!worker) {
      const known = workers.map((entry) => entry.id).join(', ') || 'none';
      return tagged(
        `worker "${requestedWorkerId}" was not discovered (known: ${known}). ` +
          'Put its executable on PATH, list it in AGY_POOL_BINS (separate entries with commas, spaces' +
          `${process.platform === 'win32' ? ' or ;' : ' or :'}), or add it to .agy-staff/config.json "workers"`,
        'worker_not_found'
      );
    }
    if (worker.available !== true && worker.status !== 'unknown') {
      return tagged(`worker "${requestedWorkerId}" (${worker.bin}) did not answer \`--version\`; check the executable`, 'worker_unavailable');
    }
    const capacity = normalizeCapacity(worker.capacity);
    return tagged(
      `worker "${requestedWorkerId}" is busy (${loadFor(worker, activeJobs)}/${capacity} active jobs); ` +
        'pick another worker, use --worker auto, or raise its capacity in .agy-staff/config.json',
      'worker_busy'
    );
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
 * wrapper `agy2`..`agy7` arranca Python e provisiona keychain na primeira
 * corrida, e 1500ms passam com facilidade sem que o binário esteja avariado
 * — por isso ganha uma segunda tentativa, mais folgada (`retryTimeoutMs`,
 * 5000ms por omissão). Só se essa segunda tentativa TAMBÉM expirar é que o
 * resultado é `'unknown'`: existe, mas não respondeu a tempo nenhuma vez.
 *
 * @returns {Promise<{status:'available'|'unavailable'|'unknown', version:string|null}>}
 */
async function probeWorker(bin, { env, timeoutMs = DEFAULT_TIMEOUT_MS, retryTimeoutMs = DEFAULT_RETRY_TIMEOUT_MS, probe }) {
  // `probe: false` skips the `--version` round trip: a status line redraws
  // every few seconds and only needs the quota cache, not ten wrapper starts.
  // Existence is still checked — it is a stat, not a process — so a default
  // candidate that is not installed stays out of the counts.
  if (probe === false) return { status: executableExists(bin, env) ? 'unknown' : 'unavailable', version: null };
  const attempt = (ms) => (probe ? probeOnce(bin, { env, timeoutMs: ms, probe }) : execProbeOnce(bin, { env, timeoutMs: ms }));

  const first = await attempt(timeoutMs);
  if (first.status !== 'retry') return first;

  const second = await attempt(retryTimeoutMs);
  if (second.status === 'retry') return { status: 'unknown', version: null };
  return second;
}

function executableExists(bin, env) {
  if (bin.includes('/') || bin.includes(pathModule.sep)) {
    try { return fs.statSync(pathModule.resolve(bin)).isFile(); } catch { return false; }
  }
  return lookupOnPath(bin, env) !== null;
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
    const agy = agyLaunch(bin, ['--version']);
    const result = await execFileAsync(agy.cmd, agy.args, { env, timeout: timeoutMs, windowsHide: true });
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
async function readQuota(cacheDir, bin, now, model) {
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
  const ageMs = Math.max(0, now - capturedAt * 1000);
  const fresh = ageMs < MAX_QUOTA_AGE_MS;
  const pool = quotaPoolForModel(model);
  return {
    slack: fresh ? slackFrom(data, now, pool) : null,
    gemini: fresh ? slackFrom(data, now, 'gemini') : null,
    thirdParty: fresh ? slackFrom(data, now, '3p') : null,
    // Reset times are reported even for an old reading: "3p is blocked
    // until 18:46" stays true however long ago it was captured.
    resetGemini: blockingResetFrom(data, now, 'gemini'),
    resetThirdParty: blockingResetFrom(data, now, '3p'),
    ageMs,
  };
}

/**
 * Synchronous slack of `model`'s pool on the worker at `bin`, straight from
 * the cache, for bookkeeping that runs inside the state lock (usage history:
 * slack when a job started and when it finished). Same rules as discovery:
 * a reading older than six hours, or a reset window, gives null.
 */
export function quotaNow(bin, model, { env = process.env, now = Date.now() } = {}) {
  const profile = quotaProfileForBin(bin);
  if (!profile || !model) return null;
  const dir = env.AGY_QUOTA_CACHE_DIR?.trim() || DEFAULT_QUOTA_CACHE_DIR;
  try {
    const data = JSON.parse(fs.readFileSync(pathModule.join(dir, `agy-quota-${profile}.json`), 'utf8'));
    const ageMs = now - Number(data?.captured_at) * 1000;
    if (!(ageMs >= 0 && ageMs < MAX_QUOTA_AGE_MS)) return null;
    return slackFrom(data, now, quotaPoolForModel(model));
  } catch {
    return null;
  }
}

/**
 * When a closed pool reopens, in epoch ms, or null when it is not closed.
 *
 * The tightest live window sets the pool's slack, so its reset is when the
 * slack can next go up. A weekly window at 100% therefore wins over an empty
 * 5h one: the 5h window does not free the pool while the weekly one is full.
 */
function blockingResetFrom(data, now, pool) {
  if (!data?.buckets || typeof data.buckets !== 'object') return null;
  let tightest = null;
  for (const [name, bucket] of Object.entries(data.buckets)) {
    if (!name.startsWith(`${pool} `) && !name.startsWith(`${pool}-`)) continue;
    const resetsAt = Number(bucket?.resets_at) * 1000;
    const used = Number(bucket?.used_percent);
    if (!Number.isFinite(resetsAt) || resetsAt <= now || !Number.isFinite(used)) continue;
    const effective = disabledWindow(data, pool, name) ? 100 : used;
    if (!tightest || effective > tightest.used || (effective === tightest.used && resetsAt > tightest.resetsAt)) {
      tightest = { used: effective, resetsAt };
    }
  }
  // Only a window that actually closes the pool has a reset worth reporting;
  // the weekly reset of a pool at 2% used is not "when it reopens".
  return tightest && tightest.used >= BLOCKED_PERCENT ? tightest.resetsAt : null;
}

/**
 * agy marks a window `disabled` in its raw status-line payload when the pool
 * is closed for a reason the percentages do not show — a 5h window reading 0%
 * used while the weekly one is exhausted. The summarized `buckets` drop that
 * flag, so it is read back from `raw.quota` (`3p-5h`, `3p-weekly`, …).
 */
function disabledWindow(data, pool, bucketName) {
  const quota = data?.raw?.quota;
  if (!quota || typeof quota !== 'object') return false;
  const span = /7d|week/i.test(bucketName) ? 'weekly' : '5h';
  return quota[`${pool}-${span}`]?.disabled === true;
}

function poolDisabled(data, pool) {
  const quota = data?.raw?.quota;
  if (!quota || typeof quota !== 'object') return false;
  return Object.entries(quota).some(([name, window]) => name.startsWith(`${pool}-`) && window?.disabled === true);
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
function slackFrom(data, now, pool = null) {
  const buckets = data?.buckets && typeof data.buckets === 'object'
    ? Object.entries(data.buckets)
      .filter(([name]) => !pool || name.startsWith(`${pool} `) || name.startsWith(`${pool}-`))
      .map(([, bucket]) => bucket)
    : pool ? []
    : [{ used_percent: data?.used_percent, resets_at: data?.resets_at }];
  // A model family is usable only when both its short and weekly windows
  // still have measurements. A reset bucket cannot be inferred from its
  // sibling: reporting 100% from the 5h bucket while 7d is unknown is false.
  if (pool && buckets.length !== 2) return null;
  const live = buckets
    .filter((bucket) => {
      const resetValue = bucket?.resets_at;
      // Sem `resets_at` não há como saber se a janela virou; conta na mesma,
      // porque descartar uma leitura por lhe faltar um campo opcional seria
      // trocar um número conservador por nenhum.
      if (resetValue === null || resetValue === undefined || resetValue === '') return true;
      const resetsAt = Number(resetValue);
      return !Number.isFinite(resetsAt) || resetsAt * 1000 > now;
    })
    .map((bucket) => bucket?.used_percent == null ? NaN : Number(bucket.used_percent))
    .filter((used) => Number.isFinite(used));
  if (pool && live.length !== buckets.length) return null;
  if (!live.length) return null;
  // A disabled window closes the pool whatever its percentage says.
  if (pool && poolDisabled(data, pool)) return 0;
  return Math.max(0, Math.min(100, 100 - Math.max(...live)));
}

/** `agy` is `principal`; `agy2`..`agy7` are `profile2`..`profile7`. Derived
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

/** Commas and whitespace always separate entries; on POSIX so does `:`, the
 *  PATH-style list people reach for first. A `:`-joined value used to arrive
 *  as one bogus executable and leave every named worker undiscovered. */
function splitBins(value) {
  if (typeof value !== 'string') return [];
  const separator = process.platform === 'win32' ? /[\s,;]+/ : /[\s,:]+/;
  return value.split(separator).map((bin) => bin.trim()).filter(Boolean);
}

function normalizeCapacity(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CAPACITY;
}

function loadFor(worker, activeJobs) {
  // A job's cross-review runs on a second account and counts there too.
  const on = (slot) => slot && (slot.id === worker.id || slot.bin === worker.bin);
  if (Array.isArray(activeJobs)) return activeJobs.filter((job) => on(job?.worker) || on(job?.review_worker)).length;
  return Number(activeJobs?.[worker.id] ?? activeJobs?.[worker.bin] ?? 0) || 0;
}
