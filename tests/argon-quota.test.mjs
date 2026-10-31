import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverWorkers, refreshQuota, routeWorker, quotaPoolForModel, slackForModel, workerHasModel,
  parseResetsIn, durationMs, argonClosedFrom, catalogModelIds, markArgonClosed,
} from '../companion/worker-pool.mjs';

// The Argon (gemini-4-argon-*) has a quota of its own, apart from Flash
// ("gemini") and Claude/GPT ("3p"), and exists only on profiles 11–13.

const available = (...bins) => async (bin) => {
  if (!bins.includes(bin)) throw new Error('not found');
  return { available: true, version: `${bin}-1.0.0` };
};
const cacheDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agy-argon-cache-'));
const OLD_CATALOG = ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'];
const NEW_CATALOG = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-3.8-flash-high',
  'claude-sonnet-5-5-medium', 'claude-opus-5-5-high'];

function writeProfile(dir, profile, { now, argonUsed, catalog, flash = 5, third = 5, ageMs = 0 }) {
  const at = now - ageMs;
  const window = (used, ahead) => ({ used_percent: used, resets_at: (now + ahead) / 1000 });
  const buckets = {
    'gemini 5h': window(flash, 3600_000), 'gemini 7d': window(flash, 86400_000),
    '3p 5h': window(third, 3600_000), '3p 7d': window(third, 86400_000),
  };
  // Same names the real hook writes.
  if (argonUsed !== undefined) buckets['gemini-argon-wtu-weekly'] = window(argonUsed, 7200_000);
  fs.writeFileSync(path.join(dir, `agy-quota-${profile}.json`), JSON.stringify({ captured_at: at / 1000, buckets }));
  if (catalog) fs.writeFileSync(path.join(dir, `agy-models-${profile}.json`), JSON.stringify({ captured_at: at / 1000, models: catalog.map((id) => ({ id, name: id })) }));
}

async function discover(dir, bins, now, extra = {}) {
  return discoverWorkers({ env: { AGY_QUOTA_CACHE_DIR: dir, AGY_POOL_BINS: bins.join(',') }, path: '/fake', now, probe: available(...bins), ...extra });
}

test('modelo -> familia de cota: argon, gemini e 3p sao tres cotas', () => {
  assert.equal(quotaPoolForModel('gemini-4-argon-low'), 'argon');
  assert.equal(quotaPoolForModel('gemini-4-argon-medium'), 'argon');
  assert.equal(quotaPoolForModel('gemini-4-argon-high'), 'argon');
  assert.equal(quotaPoolForModel('gemini-3.8-flash-high'), 'gemini');
  assert.equal(quotaPoolForModel('gemini-3.8-flash-low'), 'gemini');
  assert.equal(quotaPoolForModel('claude-sonnet-5-5-medium'), '3p');
  assert.equal(quotaPoolForModel('claude-sonnet-4-6'), '3p');
  assert.equal(quotaPoolForModel('claude-opus-4-6-thinking'), '3p');
  assert.equal(quotaPoolForModel('gpt-oss-120b-medium'), '3p');
  assert.equal(quotaPoolForModel(null), null);
});

test('a janela gemini-argon do cache nao entra na familia Flash, e a leitura do Flash volta a existir', async () => {
  const dir = cacheDir();
  const now = Date.now();
  // Real shape of profile 11: 5 buckets, the argon one named gemini-argon-wtu-weekly.
  writeProfile(dir, 'profile11', { now, argonUsed: 100, flash: 1, third: 99, catalog: NEW_CATALOG });
  const [worker] = await discover(dir, ['agy11'], now);
  assert.equal(Math.round(worker.quotaGemini), 99, 'Flash slack was "-" while the argon window counted as a third gemini bucket');
  assert.equal(Math.round(worker.quotaThirdParty), 1);
  assert.equal(worker.quotaArgon, 0);
  assert.ok(worker.quotaResetArgon > now, 'argon closed reports when it reopens');
  assert.equal(worker.quotaResetGemini, null);
  assert.equal(slackForModel(worker, 'gemini-4-argon-high'), 0);
  assert.equal(Math.round(slackForModel(worker, 'gemini-3.8-flash-low')), 99);
});

test('perfil sem janela argon tem folga argon desconhecida, nao zero', async () => {
  const dir = cacheDir();
  const now = Date.now();
  writeProfile(dir, 'profile2', { now, catalog: OLD_CATALOG });
  const [worker] = await discover(dir, ['agy2'], now);
  assert.equal(worker.quotaArgon, null);
  assert.equal(worker.quotaArgonAgeMs, null);
});

test('parse do reset "Resets in 7h54m19s" e das outras formas do AGY', () => {
  assert.equal(parseResetsIn('error: Individual quota reached. Resets in 7h54m19s.'), (7 * 3600 + 54 * 60 + 19) * 1000);
  assert.equal(parseResetsIn('Individual quota reached… Resets in 24h10m14s'), (24 * 3600 + 10 * 60 + 14) * 1000);
  assert.equal(parseResetsIn('Resets in 4h1m13s'), (4 * 3600 + 60 + 13) * 1000);
  assert.equal(parseResetsIn('Resets in 45m'), 45 * 60 * 1000);
  assert.equal(parseResetsIn('Resets in 30s'), 30_000);
  assert.equal(parseResetsIn('Resets in 2d3h'), (2 * 86400 + 3 * 3600) * 1000);
  assert.equal(parseResetsIn('quota exceeded'), null);
  assert.equal(parseResetsIn(''), null);
  assert.equal(durationMs('7h54m19s'), 28459_000);
  assert.equal(durationMs('soon'), null);
});

test('argonClosedFrom reconhece o 429 do AGY e ignora texto normal', () => {
  const text = 'error: Individual quota reached… Resets in 7h54m19s.\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429)","status":"RESOURCE_EXHAUSTED","error_code":429}';
  assert.deepEqual(argonClosedFrom(text), { resetsInMs: 28459_000 });
  assert.deepEqual(argonClosedFrom('RESOURCE_EXHAUSTED (code 429)'), { resetsInMs: null });
  assert.equal(argonClosedFrom('{"status":"SUCCESS","response":"ok"}'), null);
  assert.equal(argonClosedFrom(undefined), null);
});

test('refreshQuota sonda o Argon so em quem tem argon no catalogo e so quando a leitura argon esta ausente ou velha', async () => {
  const dir = cacheDir();
  const now = Date.now();
  const workers = [
    { id: 'agy2', bin: 'agy2', status: 'available', quotaAgeMs: 60_000, quotaArgonAgeMs: null, models: OLD_CATALOG },
    { id: 'agy11', bin: 'agy11', status: 'available', quotaAgeMs: 60_000, quotaArgonAgeMs: null, models: NEW_CATALOG },
    { id: 'agy12', bin: 'agy12', status: 'available', quotaAgeMs: 60_000, quotaArgonAgeMs: 60_000, models: NEW_CATALOG },
    { id: 'agy13', bin: 'agy13', status: 'available', quotaAgeMs: 60_000, quotaArgonAgeMs: 3600_000, models: NEW_CATALOG },
    { id: 'agy14', bin: 'agy14', status: 'unknown', quotaAgeMs: 60_000, quotaArgonAgeMs: null, models: null },
  ];
  const pings = [];
  const results = await refreshQuota(workers, { env: { AGY_QUOTA_CACHE_DIR: dir }, lockDir: cacheDir(), now,
    ping: async (bin, { model }) => { pings.push(`${bin}:${model}`); return '{"status":"SUCCESS"}'; } });
  assert.deepEqual(pings.sort(), ['agy11:gemini-4-argon-low', 'agy13:gemini-4-argon-low']);
  assert.deepEqual(results.map((r) => [r.id, r.pool, r.ok]).sort(), [['agy11', 'argon', true], ['agy13', 'argon', true]]);
});

test('sonda argon: resposta ok vira aberto; 429 com "Resets in" vira fechado ate agora + duracao', async () => {
  const dir = cacheDir();
  const now = Date.now();
  writeProfile(dir, 'profile11', { now, ageMs: 30 * 3600_000, catalog: NEW_CATALOG, argonUsed: 0 });
  writeProfile(dir, 'profile12', { now, ageMs: 30 * 3600_000, catalog: NEW_CATALOG });
  writeProfile(dir, 'profile13', { now, ageMs: 30 * 3600_000, catalog: NEW_CATALOG });
  // hook files are 30h old (stale), so only the probe can say anything
  const stale = (id) => ({ id, bin: id, status: 'available', quotaAgeMs: 30 * 3600_000, quotaArgonAgeMs: null, models: NEW_CATALOG });
  const text429 = 'error: Individual quota reached… Resets in 7h54m19s.\nAGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}';
  await refreshQuota([stale('agy11'), stale('agy12'), stale('agy13')], { env: { AGY_QUOTA_CACHE_DIR: dir }, lockDir: cacheDir(), now,
    ping: async (bin, { model }) => {
      if (model !== 'gemini-4-argon-low') return '';
      if (bin === 'agy12') return '{"status":"SUCCESS","response":"ARGON OK"}';
      // agy11 exits non-zero, agy13 exits 0 with the 429 in its text
      if (bin === 'agy11') throw Object.assign(new Error('exit 1'), { stderr: text429 });
      return text429;
    } });
  const workers = await discover(dir, ['agy11', 'agy12', 'agy13'], now);
  const by = Object.fromEntries(workers.map((w) => [w.id, w]));
  assert.equal(by.agy12.quotaArgon, 100, 'aberto');
  assert.equal(by.agy11.quotaArgon, 0);
  assert.equal(by.agy13.quotaArgon, 0);
  assert.equal(by.agy11.quotaResetArgon, now + 28459_000);
  assert.equal(by.agy13.quotaResetArgon, now + 28459_000);
  assert.ok(by.agy11.quotaArgonAgeMs < 5_000, 'idade da leitura argon e a da sonda');
  assert.equal(slackForModel(by.agy11, 'gemini-4-argon-high'), 0);
});

test('uma sonda argon mais nova que a janela do hook vale; uma mais velha nao', async () => {
  const dir = cacheDir();
  const now = Date.now();
  writeProfile(dir, 'profile11', { now, ageMs: 2 * 60_000, argonUsed: 10, catalog: NEW_CATALOG });
  markArgonClosed('agy11', '1h', { env: { AGY_QUOTA_CACHE_DIR: dir }, now: now - 3600_000 });
  let [worker] = await discover(dir, ['agy11'], now);
  assert.equal(Math.round(worker.quotaArgon), 90, 'hook mais novo que a sonda');
  markArgonClosed('agy11', '3h', { env: { AGY_QUOTA_CACHE_DIR: dir }, now: now - 60_000 });
  [worker] = await discover(dir, ['agy11'], now);
  assert.equal(worker.quotaArgon, 0, 'sonda mais nova fechou o argon');
  assert.equal(worker.quotaResetArgon, now - 60_000 + 3 * 3600_000);
  // closed until a reset that already passed: the reading no longer holds
  markArgonClosed('agy11', '10s', { env: { AGY_QUOTA_CACHE_DIR: dir }, now: now - 30_000 });
  [worker] = await discover(dir, ['agy11'], now);
  assert.equal(Math.round(worker.quotaArgon), 90);
});

test('elegibilidade por catalogo: modelo ausente do catalogo do worker nao e elegivel', () => {
  const old = { id: 'agy2', bin: 'agy2', status: 'available', available: true, models: OLD_CATALOG, quotaThirdParty: 90, quotaArgon: null };
  const modern = { id: 'agy11', bin: 'agy11', status: 'available', available: true, models: NEW_CATALOG, quotaThirdParty: 20, quotaArgon: 80 };
  const blind = { id: 'agy9', bin: 'agy9', status: 'available', available: true, models: null, quotaThirdParty: 95, quotaArgon: 90 };
  assert.equal(workerHasModel(old, 'claude-sonnet-4-6'), true);
  assert.equal(workerHasModel(old, 'claude-sonnet-5-5-medium'), false);
  assert.equal(workerHasModel(old, 'gemini-4-argon-high'), false);
  assert.equal(workerHasModel(old, 'gemini-3.1-pro-high'), false);
  assert.equal(workerHasModel(modern, 'gemini-4-argon-high'), true);
  // no catalog read: an ordinary model stays eligible, the Argon does not
  assert.equal(workerHasModel(blind, 'claude-sonnet-4-6'), true);
  assert.equal(workerHasModel(blind, 'gemini-4-argon-high'), false);

  const workers = [old, modern, blind];
  const sonnet55 = routeWorker({ workers, chain: ['claude-sonnet-5-5-medium'] });
  assert.equal(sonnet55.worker.id, 'agy9', 'agy2 lacks the model; agy9 has no catalog but 95% slack beats agy11');
  const argon = routeWorker({ workers, chain: ['gemini-4-argon-high'] });
  assert.equal(argon.worker.id, 'agy11', 'only the profile that lists the Argon, whatever the others read');
  assert.equal(routeWorker({ workers: [old], chain: ['gemini-4-argon-high', 'claude-sonnet-5-5-medium'] }), null);
  assert.equal(routeWorker({ workers: [old], chain: ['gemini-4-argon-high', 'claude-sonnet-4-6'] }).model, 'claude-sonnet-4-6');
});

test('o catalogo de cada perfil vem do cache agy-models e catalogModelIds junta todos', async () => {
  const dir = cacheDir();
  const now = Date.now();
  writeProfile(dir, 'profile2', { now, catalog: OLD_CATALOG });
  writeProfile(dir, 'profile11', { now, catalog: NEW_CATALOG });
  const workers = await discover(dir, ['agy2', 'agy11'], now);
  assert.deepEqual(workers.find((w) => w.id === 'agy2').models, OLD_CATALOG);
  assert.deepEqual(workers.find((w) => w.id === 'agy11').models, NEW_CATALOG);
  const ids = catalogModelIds({ env: { AGY_QUOTA_CACHE_DIR: dir } });
  assert.ok(ids.includes('gemini-4-argon-high') && ids.includes('claude-sonnet-4-6'));
  assert.ok(!ids.some((id) => id.startsWith('gemini-3.1-pro')));
  assert.deepEqual(catalogModelIds({ env: { AGY_QUOTA_CACHE_DIR: path.join(dir, 'missing') } }), []);
});
