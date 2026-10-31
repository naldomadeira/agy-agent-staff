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

/**
 * A família de cota de um modelo. Três cotas independentes por conta:
 * `argon` (gemini-4-argon-*, só nos perfis 11–13), `gemini` (Flash) e `3p`
 * (claude-*, gpt-*). O Argon começa por `gemini-` mas NÃO gasta a cota do
 * Flash: tratá-lo como `gemini` foi o que o fez parecer aberto numa conta
 * onde o Argon está esgotado há horas.
 */
export function quotaPoolForModel(model) {
  if (!model) return null;
  if (model.startsWith('gemini-4-argon')) return 'argon';
  return model.startsWith('gemini-') ? 'gemini' : '3p';
}

/** Worker fields that hold each pool's slack and reopen time. */
export const POOL_FIELDS = {
  gemini: { slack: 'quotaGemini', reset: 'quotaResetGemini', age: 'quotaAgeMs' },
  argon: { slack: 'quotaArgon', reset: 'quotaResetArgon', age: 'quotaArgonAgeMs' },
  '3p': { slack: 'quotaThirdParty', reset: 'quotaResetThirdParty', age: 'quotaAgeMs' },
};

/** Below this slack a pool counts as closed for routing: a job would start
 *  and die minutes in, burning the account's window for nothing. */
export const OPEN_SLACK_PERCENT = 5;

/** The measured slack of `model`'s pool on `worker`, or null when unknown. */
export function slackForModel(worker, model) {
  const fields = POOL_FIELDS[quotaPoolForModel(model)];
  const value = fields ? worker[fields.slack] : undefined;
  return typeof value === 'number' ? value : null;
}

/**
 * Whether `worker` can run `model`, by the catalog `agy models` gave for its
 * profile (`worker.models`). Modelo fora do catálogo não é elegível: o
 * `gemini-3.1-pro` que já não existe em perfil nenhum falhava com
 * `unsupported-model` só depois de reservado o worker. Sem catálogo lido
 * (`models` nulo) um modelo comum segue elegível — falta de leitura não é
 * ausência —, mas o Argon não: ele só existe nos perfis 11–13, e despachar
 * às cegas para uma conta que talvez nem o tenha é o palpite que `auto` evita.
 */
export function workerHasModel(worker, model) {
  if (Array.isArray(worker?.models)) return worker.models.includes(model);
  return quotaPoolForModel(model) !== 'argon';
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
      .filter((worker) => workerHasModel(worker, model))
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
    const models = await readCatalog(quotaCacheDir, entry.bin);
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
      quotaArgon: quota ? quota.argon : null,
      quotaResetArgon: quota ? quota.resetArgon : null,
      quotaArgonAgeMs: quota ? quota.argonAgeMs : null,
      models,
    };
  }));
}

export const PROBE_MODEL = 'gemini-3.8-flash-low';
/** O Argon tem cota própria: a sonda do Flash não diz nada sobre ele. */
export const ARGON_PROBE_MODEL = 'gemini-4-argon-low';
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
 * O Argon é outra cota: nos workers cujo catálogo (`worker.models`) tem
 * `gemini-4-argon-*`, uma segunda sonda mínima com `gemini-4-argon-low` corre
 * quando a leitura argon está ausente ou velha (a do hook, se há janela
 * argon no cache, ou a da última sonda argon, o que for mais novo). O
 * resultado vai para um ficheiro próprio (`agy-staff-argon-<perfil>.json`),
 * nunca para o do hook.
 *
 * @returns {Promise<Array<{id:string, ok:boolean, ms:number, pool:string, error?:string}>>}
 */
export async function refreshQuota(workers, { env = process.env, maxAgeMs = DEFAULT_PROBE_MAX_AGE_MS, timeoutMs = 60000, ping, lockDir = os.tmpdir(), now = Date.now() } = {}) {
  const live = workers.filter((worker) => worker.status !== 'unavailable');
  const stale = live.filter((worker) => typeof worker.quotaAgeMs !== 'number' || worker.quotaAgeMs >= maxAgeMs);
  const staleArgon = live.filter((worker) => Array.isArray(worker.models) && worker.models.some((id) => quotaPoolForModel(id) === 'argon')
    && (typeof worker.quotaArgonAgeMs !== 'number' || worker.quotaArgonAgeMs >= maxAgeMs));
  const run = ping ?? pingWorker;
  const cacheDir = env.AGY_QUOTA_CACHE_DIR?.trim() || DEFAULT_QUOTA_CACHE_DIR;
  const probeOne = (worker, pool) => async () => {
    const started = Date.now();
    // Ten parallel `--model auto` dispatches would otherwise ping every
    // stale account ten times. The first one takes a short-lived lock; the
    // rest skip that account and read whatever the first one refreshed.
    const release = probeLock(lockDir, { id: pool === 'argon' ? `${worker.id}-argon` : worker.id }, timeoutMs + 10000);
    if (!release) return { id: worker.id, pool, ok: true, ms: 0, skipped: 'probe already running' };
    try {
      const output = await run(worker.bin, { env, timeoutMs, model: pool === 'argon' ? ARGON_PROBE_MODEL : PROBE_MODEL });
      if (pool === 'argon') {
        // An exit-0 answer can still carry the 429 in its text.
        const closed = argonClosedFrom(output);
        writeArgonReading(cacheDir, worker.bin, closed ? { open: false, resetsInMs: closed.resetsInMs } : { open: true }, now);
        return { id: worker.id, pool, ok: true, ms: Date.now() - started, ...(closed ? { error: 'quota_exhausted' } : {}) };
      }
      return { id: worker.id, pool, ok: true, ms: Date.now() - started };
    } catch (error) {
      const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}${error?.message ?? ''}`;
      // An exhausted pool still answers with its quota, and the hook has
      // recorded it by the time the error surfaces: that is a reading.
      const exhausted = /RESOURCE_EXHAUSTED|quota/i.test(text);
      if (pool === 'argon' && exhausted) {
        const closed = argonClosedFrom(text);
        if (closed) writeArgonReading(cacheDir, worker.bin, { open: false, resetsInMs: closed.resetsInMs }, now);
      }
      return { id: worker.id, pool, ok: exhausted, ms: Date.now() - started, error: exhausted ? 'quota_exhausted' : firstLine(text) };
    } finally {
      release();
    }
  };
  return Promise.all([
    ...stale.map((worker) => probeOne(worker, 'gemini')()),
    ...staleArgon.map((worker) => probeOne(worker, 'argon')()),
  ]);
}

/** `{resetsInMs}` when `text` carries AGY's individual-quota 429, else null.
 *  `resetsInMs` is null when the text names no reset ("Resets in …"). */
export function argonClosedFrom(text) {
  const body = String(text ?? '');
  if (!/RESOURCE_EXHAUSTED|Individual quota reached|quota exceeded|\bcode\s*429\b/i.test(body)) return null;
  return { resetsInMs: parseResetsIn(body) };
}

/** The duration AGY prints after "Resets in" ("7h54m19s", "24h10m14s",
 *  "2d3h"), in milliseconds, or null when the text has none. */
export function parseResetsIn(text) {
  const match = /Resets in\s+((?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?)(?![0-9a-z])/i.exec(String(text ?? ''));
  return match ? durationMs(match[1]) : null;
}

/** "7h54m19s" → ms. Null for an empty or unparsable string. */
export function durationMs(value) {
  const parts = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(String(value ?? '').trim());
  if (!parts || parts.slice(1).every((part) => part === undefined)) return null;
  const [days, hours, minutes, seconds] = parts.slice(1).map((part) => Number(part ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function argonFile(cacheDir, bin) {
  const profile = quotaProfileForBin(bin);
  return profile ? pathModule.join(cacheDir, `agy-staff-argon-${profile}.json`) : null;
}

/**
 * Regista o que se sabe do Argon numa conta, fora do ficheiro do hook (que
 * este processo nunca escreve): `open` vem de uma sonda que respondeu;
 * fechado traz o reset que o AGY disse. Também é chamado quando um job morre
 * de quota com um modelo argon.
 */
export function writeArgonReading(cacheDir, bin, { open, resetsInMs = null }, now = Date.now()) {
  const file = argonFile(cacheDir, bin);
  if (!file) return false;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      checked_at: now / 1000, open: !!open,
      reopens_at: !open && typeof resetsInMs === 'number' ? (now + resetsInMs) / 1000 : null,
    }));
    return true;
  } catch {
    return false;
  }
}

/** Convenience for the job-death path: the Argon of `bin` is closed. */
export function markArgonClosed(bin, resetsIn, { env = process.env, now = Date.now() } = {}) {
  const cacheDir = env.AGY_QUOTA_CACHE_DIR?.trim() || DEFAULT_QUOTA_CACHE_DIR;
  const resetsInMs = typeof resetsIn === 'number' ? resetsIn : durationMs(resetsIn);
  return writeArgonReading(cacheDir, bin, { open: false, resetsInMs }, now);
}

function readArgonReading(cacheDir, bin) {
  const file = argonFile(cacheDir, bin);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const checked = Number(data?.checked_at) * 1000;
    if (!Number.isFinite(checked)) return null;
    const reopens = Number(data?.reopens_at) * 1000;
    return { checkedAtMs: checked, open: data.open === true, reopensAtMs: Number.isFinite(reopens) ? reopens : null };
  } catch {
    return null;
  }
}

/**
 * The model ids of the catalog `agy models` gave for the profile at `bin`
 * (cache file `agy-models-<profile>.json`, written outside this process), or
 * null when there is no readable catalog.
 */
async function readCatalog(cacheDir, bin) {
  const profile = quotaProfileForBin(bin);
  if (!profile) return null;
  return parseCatalog(await readFile(pathModule.join(cacheDir, `agy-models-${profile}.json`), 'utf8').catch(() => null));
}

function parseCatalog(raw) {
  try {
    const ids = JSON.parse(raw)?.models?.map((model) => model?.id).filter((id) => typeof id === 'string');
    return ids?.length ? ids : null;
  } catch {
    return null;
  }
}

/** Every model id some cached profile catalog lists, sorted. Empty when no
 *  catalog was ever cached. Used to say what DOES exist when a model does not. */
export function catalogModelIds({ env = process.env } = {}) {
  const dir = env.AGY_QUOTA_CACHE_DIR?.trim() || DEFAULT_QUOTA_CACHE_DIR;
  const ids = new Set();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^agy-models-.*\.json$/.test(name)) continue;
      for (const id of parseCatalog(fs.readFileSync(pathModule.join(dir, name), 'utf8')) ?? []) ids.add(id);
    }
  } catch { /* no cache dir: nothing to list */ }
  return [...ids].sort();
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

async function pingWorker(bin, { env, timeoutMs, model = PROBE_MODEL }) {
  const cwd = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'agy-probe-'));
  try {
    const agy = agyLaunch(bin, ['-p', 'Reply with the single word: ok', '--model', model,
      '--output-format', 'json', '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`]);
    const result = await execFileAsync(agy.cmd, agy.args, { env, cwd, timeout: timeoutMs + 5000, windowsHide: true });
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
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
  const argon = argonReading(data, fresh, ageMs, readArgonReading(cacheDir, bin), now);
  return {
    slack: pool === 'argon' ? argon.slack : fresh ? slackFrom(data, now, pool) : null,
    gemini: fresh ? slackFrom(data, now, 'gemini') : null,
    thirdParty: fresh ? slackFrom(data, now, '3p') : null,
    // Reset times are reported even for an old reading: "3p is blocked
    // until 18:46" stays true however long ago it was captured.
    resetGemini: blockingResetFrom(data, now, 'gemini'),
    resetThirdParty: blockingResetFrom(data, now, '3p'),
    argon: argon.slack,
    resetArgon: argon.reset,
    argonAgeMs: argon.ageMs,
    ageMs,
  };
}

/**
 * A leitura do Argon de uma conta: a janela `gemini-argon-*` que o hook
 * grava e/ou a última sonda/morte por quota registada pelo companion
 * (`agy-staff-argon-<perfil>.json`). Vale a mais nova das duas. Uma sonda que
 * achou o Argon fechado vale até ao reset que o AGY informou; uma que o achou
 * aberto prova só isso — sem janela medida a folga é 100, e a idade diz o
 * quanto confiar. Sem nenhuma das duas, folga e idade são null.
 */
function argonReading(data, fresh, hookAgeMs, probe, now) {
  const hasWindow = poolBuckets(data, 'argon').length > 0;
  const hook = hasWindow ? {
    slack: fresh ? slackFrom(data, now, 'argon') : null,
    reset: blockingResetFrom(data, now, 'argon'),
    ageMs: hookAgeMs,
  } : { slack: null, reset: null, ageMs: null };
  if (!probe) return hook;
  const probeAgeMs = Math.max(0, now - probe.checkedAtMs);
  if (probeAgeMs >= MAX_QUOTA_AGE_MS || (hook.ageMs !== null && hook.ageMs <= probeAgeMs)) return hook;
  if (!probe.open) {
    // A closed reading holds until the reset AGY reported, not for six hours.
    if (probe.reopensAtMs !== null && probe.reopensAtMs <= now) return hook;
    return { slack: 0, reset: probe.reopensAtMs, ageMs: probeAgeMs };
  }
  return { slack: hook.slack ?? 100, reset: null, ageMs: probeAgeMs };
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
    const pool = quotaPoolForModel(model);
    if (pool === 'argon') return argonReading(data, true, ageMs, readArgonReading(dir, bin), now).slack;
    return slackFrom(data, now, pool);
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
    if (!inPool(name, pool)) continue;
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
  // The Argon window is a single bucket named like its raw entry.
  if (pool === 'argon') return quota[bucketName]?.disabled === true;
  const span = /7d|week/i.test(bucketName) ? 'weekly' : '5h';
  return quota[`${pool}-${span}`]?.disabled === true;
}

function poolDisabled(data, pool) {
  const quota = data?.raw?.quota;
  if (!quota || typeof quota !== 'object') return false;
  return Object.entries(quota).some(([name, window]) => inPool(name, pool) && window?.disabled === true);
}

const POOL_PREFIX = { gemini: 'gemini', argon: 'gemini-argon', '3p': '3p' };

/** Whether a bucket / raw-window name belongs to `pool`. `gemini-argon-…`
 *  starts with `gemini-` but is its own pool: counting it for the Flash pool
 *  gave that pool three windows and read as "no measurement" (`-`). */
function inPool(name, pool) {
  if (pool === 'gemini' && name.startsWith('gemini-argon')) return false;
  const prefix = POOL_PREFIX[pool] ?? pool;
  return name.startsWith(`${prefix} `) || name.startsWith(`${prefix}-`);
}

function poolBuckets(data, pool) {
  return data?.buckets && typeof data.buckets === 'object'
    ? Object.entries(data.buckets).filter(([name]) => inPool(name, pool)).map(([, bucket]) => bucket)
    : [];
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
      .filter(([name]) => !pool || inPool(name, pool))
      .map(([, bucket]) => bucket)
    : pool ? []
    : [{ used_percent: data?.used_percent, resets_at: data?.resets_at }];
  // A model family is usable only when both its short and weekly windows
  // still have measurements. A reset bucket cannot be inferred from its
  // sibling: reporting 100% from the 5h bucket while 7d is unknown is false.
  // (The Argon pool is one weekly window, so it needs only that one.)
  if (pool && buckets.length !== (pool === 'argon' ? 1 : 2)) return null;
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
