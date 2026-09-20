import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverWorkers, reserveWorker, selectWorker } from '../companion/worker-pool.mjs';

const available = (...bins) => async (bin) => {
  if (!bins.includes(bin)) throw new Error('not found');
  return { available: true, version: `${bin}-1.0.0` };
};

/** A throwaway PATH entry holding one executable — no process ever runs it;
 *  discovery only needs it to exist and be executable to canonicalize a name. */
function fakeBinDir(name) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pool-bin-')));
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return dir;
}

/** The companion counts a job as load while it is running; simulated here so
 *  the test stays a pure function of the state object. */
const running = (job) => job.status === 'running';

/** assert.throws does not hand back the error, and these messages exist to be
 *  read by a human stuck mid-recovery, so they are asserted in detail. */
function thrown(fn) {
  try { fn(); } catch (error) { return error; }
  throw new assert.AssertionError({ message: 'expected a throw' });
}

test('descobre somente agy e usa capacidade padrão 1', async () => {
  const workers = await discoverWorkers({
    env: {},
    path: '/fake',
    probe: available('agy'),
  });

  assert.equal(workers.find((worker) => worker.bin === 'agy')?.available, true);
  assert.deepEqual(workers.map((worker) => worker.bin), ['agy', 'agy2', 'agy3']);
});

test('descobre agy, agy2 e agy3 preservando a ordem', async () => {
  const workers = await discoverWorkers({
    env: {},
    path: '/fake',
    probe: available('agy', 'agy2', 'agy3'),
  });

  assert.deepEqual(workers.map(({ id, bin }) => ({ id, bin })), [
    { id: 'agy', bin: 'agy' },
    { id: 'agy2', bin: 'agy2' },
    { id: 'agy3', bin: 'agy3' },
  ]);
});

test('reporta nenhum worker disponível sem falhar', async () => {
  const workers = await discoverWorkers({ env: {}, path: '/fake', probe: async () => { throw new Error('no'); } });
  assert.equal(workers.every((worker) => !worker.available), true);
});

test('prioriza AGY_BIN e deduplica binários', async () => {
  const workers = await discoverWorkers({
    env: { AGY_BIN: '/opt/agy-primary', AGY_POOL_BINS: 'agy2,agy3' },
    path: '/fake',
    probe: available('/opt/agy-primary', 'agy2', 'agy3'),
  });
  assert.deepEqual(workers.map((worker) => worker.bin), ['/opt/agy-primary', 'agy2', 'agy3', 'agy']);
});

test('inclui AGY_POOL_BINS e configuração explícita com id e capacidade', async () => {
  const workers = await discoverWorkers({
    env: { AGY_POOL_BINS: 'agy2 agy3' },
    path: '/fake',
    config: { workers: [{ id: 'secondary', bin: '/opt/agy2', capacity: 2 }] },
    probe: available('agy2', 'agy3', '/opt/agy2'),
  });
  assert.deepEqual(workers.map(({ id, bin, capacity }) => ({ id, bin, capacity })), [
    { id: 'agy2', bin: 'agy2', capacity: 1 },
    { id: 'agy3', bin: 'agy3', capacity: 1 },
    { id: 'agy', bin: 'agy', capacity: 1 },
    { id: 'secondary', bin: '/opt/agy2', capacity: 2 },
  ]);
});

test('deduplica e aplica id/capacidade da configuração ao bin já descoberto', async () => {
  const workers = await discoverWorkers({
    // A folga de quota vem do disco (ver testes de quota, mais abaixo); um
    // diretório de cache isolado e vazio é o que impede este teste de ler
    // ~/.codex-profiles/cache da máquina que o corre.
    env: { AGY_POOL_BINS: 'agy', AGY_QUOTA_CACHE_DIR: path.join(os.tmpdir(), 'agy-quota-cache-empty-does-not-exist') },
    path: '/fake', config: { workers: [{ id: 'primary', bin: 'agy', capacity: 4 }] }, probe: available('agy'),
  });
  assert.equal(workers.filter((worker) => worker.bin === 'agy').length, 1);
  assert.deepEqual(workers.find((worker) => worker.bin === 'agy'), {
    id: 'primary', bin: 'agy', available: true, status: 'available', version: 'agy-1.0.0', capacity: 4,
    quotaSlack: null, quotaAgeMs: null,
  });
});

test('seleciona o worker disponível com menor carga dentro da capacidade', () => {
  const workers = [
    { id: 'agy', bin: 'agy', available: true, capacity: 1 },
    { id: 'agy2', bin: 'agy2', available: true, capacity: 2 },
    { id: 'agy3', bin: 'agy3', available: false, capacity: 1 },
  ];
  assert.equal(selectWorker({ workers, activeJobs: { agy: 1, agy2: 0, agy3: 0 } }).id, 'agy2');
  assert.equal(selectWorker({ workers, activeJobs: { agy: 1, agy2: 2 } }), null);
});

test('respeita afinidade por id e por bin, mesmo quando outra carga é menor', () => {
  const workers = [
    { id: 'primary', bin: 'agy', available: true, capacity: 1 },
    { id: 'secondary', bin: 'agy2', available: true, capacity: 1 },
  ];
  assert.equal(selectWorker({ workers, activeJobs: { primary: 0, secondary: 0 }, affinity: { id: 'secondary', bin: 'agy2' } }).id, 'secondary');
  assert.equal(selectWorker({ workers, activeJobs: {}, affinity: { id: 'renamed-primary', bin: 'agy' } }).id, 'primary');
  assert.equal(selectWorker({ workers, activeJobs: {}, affinity: { id: 'missing', bin: 'missing' } }), null);
});

test('deduplica o mesmo executável alcançado por AGY_BIN absoluto e pelo PATH', async () => {
  const dir = fakeBinDir('agy');
  const workers = await discoverWorkers({
    env: { AGY_BIN: path.join(dir, 'agy') },
    path: dir,
    probe: available(path.join(dir, 'agy')),
  });

  // Antes: {id:'agy',bin:'<dir>/agy'} e {id:'agy',bin:'agy'} — o mesmo binário
  // duas vezes com o mesmo id, tornando `--worker agy` ambíguo, contando um
  // job contra as duas linhas e duplicando a capacidade real da pool.
  assert.deepEqual(workers.filter((worker) => worker.id === 'agy').map((worker) => worker.bin), [path.join(dir, 'agy')]);
  assert.equal(workers.filter((worker) => worker.available).length, 1);
});

test('desambigua ids que colidem entre executáveis distintos', async () => {
  const first = fakeBinDir('agy2');
  const second = fakeBinDir('agy2');
  const workers = await discoverWorkers({
    env: { AGY_POOL_BINS: `${path.join(first, 'agy2')},${path.join(second, 'agy2')}` },
    path: '/fake',
    probe: available(path.join(first, 'agy2'), path.join(second, 'agy2')),
  });

  const ids = workers.map((worker) => worker.id);
  assert.equal(new Set(ids).size, ids.length, 'cada worker precisa de um id endereçável por --worker');
  assert.deepEqual(workers.slice(0, 2).map(({ id, bin }) => ({ id, bin })), [
    { id: 'agy2', bin: path.join(first, 'agy2') },
    { id: 'agy2-2', bin: path.join(second, 'agy2') },
  ]);
});

test('a reserva revalida a capacidade no registo, não na descoberta', () => {
  // Um único snapshot de descoberta, tirado com a pool ociosa e partilhado
  // pelos dois dispatches: exatamente a vista obsoleta que a seleção fora do
  // lock usava. A carga tem de ser recalculada em cada reserva.
  const workers = [
    { id: 'agy2', bin: 'agy2', available: true, version: null, capacity: 1 },
    { id: 'agy3', bin: 'agy3', available: true, version: null, capacity: 1 },
  ];
  const state = { jobs: [] };
  const dispatch = (id) => reserveWorker(state, { workers, isRunning: running, job: { id, status: 'running' } });

  const first = dispatch('job-1');
  const second = dispatch('job-2');

  assert.notEqual(first.id, second.id, 'dois dispatches não podem partilhar um worker de capacidade 1');
  assert.deepEqual(state.jobs.map((job) => job.worker.id), [first.id, second.id]);
  assert.throws(() => dispatch('job-3'), /no available AGY worker found/);
});

test('a reserva conta apenas jobs vivos e respeita pinned sem consultar a pool', () => {
  const workers = [{ id: 'agy2', bin: 'agy2', available: true, version: null, capacity: 1 }];
  const state = { jobs: [{ id: 'old', status: 'done', worker: { id: 'agy2', bin: 'agy2' } }] };

  const reserved = reserveWorker(state, { workers, isRunning: running, job: { id: 'new', status: 'running' } });
  assert.equal(reserved.id, 'agy2');
  assert.throws(() => reserveWorker(state, { workers, isRunning: running }), /no available AGY worker found/);

  const pinned = { id: 'default', bin: '/usr/local/bin/agy', version: null, capacity: 1 };
  const legacy = reserveWorker(state, { pinned, workers: [], isRunning: running, job: { id: 'legacy', status: 'running' } });
  assert.deepEqual(legacy, pinned);
  assert.deepEqual(state.jobs.at(-1).worker, pinned);
});

test('distingue worker ocupado de worker indisponível no ramo de afinidade', () => {
  const workers = [{ id: 'agy2', bin: 'agy2', available: true, version: null, capacity: 1 }];
  const state = { jobs: [{ id: 'j1', status: 'running', worker: { id: 'agy2', bin: 'agy2' } }] };
  const reserve = (affinity) => reserveWorker(state, { workers, affinity, isRunning: running });

  const busy = thrown(() => reserve({ id: 'agy2', bin: 'agy2' }));
  assert.equal(busy.reason, 'worker_busy');
  assert.match(busy.message, /worker agy2 for this job is busy \(1\/1 active jobs\)/);
  assert.doesNotMatch(busy.message, /unavailable/);
  assert.match(busy.message, /wait for it to finish, cancel one of its jobs/);

  const gone = thrown(() => reserve({ id: 'agy9', bin: '/gone/agy9' }));
  assert.equal(gone.reason, 'worker_unavailable');
  assert.match(gone.message, /worker agy9 for this job is unavailable; refusing automatic migration/);
});

test('afinidade ocupada não migra para um homónimo com o mesmo nome de executável', () => {
  // O candidato nu `agy2` do PATH tem bin 'agy2' e é outro executável. Antes,
  // a afinidade casava id contra bin, por isso um worker apenas ocupado era
  // silenciosamente trocado pelo homónimo — o oposto do que afinidade promete.
  const workers = [
    { id: 'agy2', bin: '/opt/pool/agy2', available: true, version: null, capacity: 1 },
    { id: 'agy2-2', bin: 'agy2', available: true, version: null, capacity: 1 },
  ];
  const affinity = { id: 'agy2', bin: '/opt/pool/agy2' };
  const state = { jobs: [{ id: 'j1', status: 'running', worker: affinity }] };

  assert.equal(selectWorker({ workers, activeJobs: state.jobs, affinity }), null);
  const error = thrown(() => reserveWorker(state, { workers, affinity, isRunning: running }));
  assert.equal(error.reason, 'worker_busy');
  assert.match(error.message, /worker agy2 for this job is busy/);
});

// --- Sonda: classes de erro e uma nova tentativa --------------------------

/** Mimics what a rejected execFile promise looks like on a timeout kill:
 *  `killed: true` and `signal: 'SIGTERM'`, with `code` left `null` — verified
 *  by actually running `execFile` against a slow child process. */
function timeoutError() {
  return Object.assign(new Error('command timed out'), { killed: true, signal: 'SIGTERM', code: null });
}

function systemError(code) {
  return Object.assign(new Error(code), { code });
}

// discoverWorkers always probes the default candidates (agy/agy2/agy3)
// alongside anything configured, and does so concurrently — so call counts
// below are tracked per bin, in a Map, rather than with one shared counter.

test('ENOENT não faz retry e dá unavailable', async () => {
  const calls = new Map();
  const probe = async (bin) => {
    calls.set(bin, (calls.get(bin) ?? 0) + 1);
    throw systemError('ENOENT');
  };
  const workers = await discoverWorkers({ env: {}, path: '/fake', probe });
  assert.ok(workers.length > 0);
  for (const worker of workers) {
    assert.equal(worker.status, 'unavailable');
    assert.equal(worker.available, false);
    assert.equal(calls.get(worker.bin), 1, `sem retry para ${worker.bin}`);
  }
});

test('EACCES/EPERM/ENOTDIR também são finais, sem retry', async () => {
  for (const code of ['EACCES', 'EPERM', 'ENOTDIR']) {
    const calls = new Map();
    const probe = async (bin) => {
      calls.set(bin, (calls.get(bin) ?? 0) + 1);
      throw systemError(code);
    };
    const workers = await discoverWorkers({ env: {}, path: '/fake', probe });
    assert.equal(workers.every((worker) => worker.status === 'unavailable'), true, code);
    assert.equal([...calls.values()].every((n) => n === 1), true, `sem retry para ${code}`);
  }
});

test('timeout faz exatamente uma segunda tentativa, com um timeout maior', async () => {
  const calls = new Map();
  const probe = async (bin, { timeoutMs }) => {
    const seen = calls.get(bin) ?? [];
    seen.push(timeoutMs);
    calls.set(bin, seen);
    if (bin === '/opt/agy-solo' && seen.length === 1) throw timeoutError();
    if (bin !== '/opt/agy-solo') throw new Error('not found');
    return { available: true, version: `${bin}-1.0.0` };
  };
  const workers = await discoverWorkers({
    env: {}, path: '/fake', probe, timeoutMs: 1500, retryTimeoutMs: 5000,
    config: { workers: [{ id: 'solo', bin: '/opt/agy-solo' }] },
  });
  const solo = workers.find((worker) => worker.id === 'solo');
  assert.deepEqual(calls.get('/opt/agy-solo'), [1500, 5000], 'exatamente uma nova tentativa, com o timeout maior');
  assert.equal(solo.status, 'available');
  assert.equal(solo.available, true);
});

test('dois timeouts seguidos dão status unknown, não unavailable', async () => {
  const calls = new Map();
  const probe = async (bin) => {
    calls.set(bin, (calls.get(bin) ?? 0) + 1);
    if (bin === '/opt/agy-solo') throw timeoutError();
    throw new Error('not found');
  };
  const workers = await discoverWorkers({
    env: {}, path: '/fake', probe,
    config: { workers: [{ id: 'solo', bin: '/opt/agy-solo' }] },
  });
  const solo = workers.find((worker) => worker.id === 'solo');
  assert.equal(calls.get('/opt/agy-solo'), 2);
  assert.equal(solo.status, 'unknown');
  assert.equal(solo.available, false, 'available continua booleano para quem já o lê');
  assert.equal(solo.version, null);
});

test('auto prefere quem respondeu à sonda, mas não descarta o unknown', () => {
  const workers = [
    { id: 'agy', bin: 'agy', available: true, status: 'available', capacity: 1 },
    { id: 'agy4', bin: 'agy4', available: false, status: 'unknown', capacity: 1 },
  ];
  assert.equal(selectWorker({ workers, activeJobs: {} }).id, 'agy', 'com um disponível livre, é esse');
  assert.equal(selectWorker({ workers, activeJobs: {}, requestedWorkerId: 'agy4' })?.id, 'agy4', 'pedido explícito seleciona o unknown');
  assert.equal(selectWorker({ workers, activeJobs: {}, affinity: { id: 'agy4', bin: 'agy4' } })?.id, 'agy4', 'afinidade também seleciona o unknown');
});

test('auto usa um unknown quando não há mais nada livre', () => {
  // Capacidade parada não falha nunca, e por isso ninguém a vê. Um despacho
  // para um worker que afinal está morto falha depressa e em voz alta.
  const workers = [
    { id: 'agy', bin: 'agy', available: true, status: 'available', capacity: 1 },
    { id: 'agy4', bin: 'agy4', available: false, status: 'unknown', capacity: 1 },
  ];
  const ocupado = [{ worker: { id: 'agy', bin: 'agy' } }];
  assert.equal(selectWorker({ workers, activeJobs: ocupado }).id, 'agy4');
});

test('auto continua a recusar um unavailable, que é final', () => {
  const workers = [
    { id: 'agy', bin: 'agy', available: true, status: 'available', capacity: 1 },
    { id: 'agy9', bin: 'agy9', available: false, status: 'unavailable', capacity: 1 },
  ];
  const ocupado = [{ worker: { id: 'agy', bin: 'agy' } }];
  assert.equal(selectWorker({ workers, activeJobs: ocupado }), null, 'binário ausente não é capacidade');
});

test('entre dois unknown, a folga de quota continua a desempatar', () => {
  const workers = [
    { id: 'agy4', bin: 'agy4', available: false, status: 'unknown', capacity: 1, quotaSlack: 10 },
    { id: 'agy5', bin: 'agy5', available: false, status: 'unknown', capacity: 1, quotaSlack: 90 },
  ];
  assert.equal(selectWorker({ workers, activeJobs: {} }).id, 'agy5');
});

// --- Quota: folga vinda do disco -------------------------------------------

function quotaDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-quota-cache-'));
}

function writeQuota(dir, profile, { usedPercent, capturedAtMs }) {
  fs.writeFileSync(
    path.join(dir, `agy-quota-${profile}.json`),
    JSON.stringify({ profile, used_percent: usedPercent, captured_at: capturedAtMs / 1000 })
  );
}

test('lê a folga e a idade de um diretório de cache temporário', async () => {
  const dir = quotaDir();
  const now = Date.now();
  writeQuota(dir, 'principal', { usedPercent: 30, capturedAtMs: now - 10 * 60 * 1000 });

  const workers = await discoverWorkers({
    env: { AGY_QUOTA_CACHE_DIR: dir },
    path: '/fake',
    now,
    probe: available('agy'),
  });

  const agy = workers.find((worker) => worker.bin === 'agy');
  assert.equal(agy.quotaSlack, 70);
  assert.equal(agy.quotaAgeMs, 10 * 60 * 1000);
});

test('mapeia agy2..agy5 para profile2..profile5 pelo nome do executável', async () => {
  const dir = quotaDir();
  const now = Date.now();
  writeQuota(dir, 'profile3', { usedPercent: 90, capturedAtMs: now });

  const workers = await discoverWorkers({
    env: { AGY_QUOTA_CACHE_DIR: dir, AGY_POOL_BINS: 'agy3' },
    path: '/fake',
    now,
    probe: available('agy3'),
  });

  const agy3 = workers.find((worker) => worker.bin === 'agy3');
  assert.equal(agy3.quotaSlack, 10);
});

test('cache ausente não parte nada: folga e idade ficam null', async () => {
  const dir = quotaDir();
  const workers = await discoverWorkers({ env: { AGY_QUOTA_CACHE_DIR: dir }, path: '/fake', probe: available('agy') });
  const agy = workers.find((worker) => worker.bin === 'agy');
  assert.equal(agy.quotaSlack, null);
  assert.equal(agy.quotaAgeMs, null);
});

test('JSON corrompido não parte nada: folga fica null', async () => {
  const dir = quotaDir();
  fs.writeFileSync(path.join(dir, 'agy-quota-principal.json'), '{ not json');
  const workers = await discoverWorkers({ env: { AGY_QUOTA_CACHE_DIR: dir }, path: '/fake', probe: available('agy') });
  const agy = workers.find((worker) => worker.bin === 'agy');
  assert.equal(agy.quotaSlack, null);
});

test('worker sem ficheiro de quota correspondente não tem folga, sem ser erro', async () => {
  const dir = quotaDir();
  writeQuota(dir, 'principal', { usedPercent: 10, capturedAtMs: Date.now() });
  const workers = await discoverWorkers({
    env: { AGY_BIN: '/opt/agy-primary', AGY_QUOTA_CACHE_DIR: dir },
    path: '/fake',
    probe: available('/opt/agy-primary'),
  });
  const custom = workers.find((worker) => worker.bin === '/opt/agy-primary');
  assert.equal(custom.quotaSlack, null);
});

/** Uma leitura com janelas nomeadas, como a que o hook escreve de verdade. */
function writeQuotaBuckets(dir, profile, { capturedAtMs, buckets }) {
  fs.writeFileSync(
    path.join(dir, `agy-quota-${profile}.json`),
    JSON.stringify({
      profile,
      captured_at: capturedAtMs / 1000,
      buckets: Object.fromEntries(
        Object.entries(buckets).map(([name, b]) => [
          name,
          { used_percent: b.usedPercent, resets_at: b.resetsAtMs / 1000 },
        ])
      ),
    })
  );
}

test('uma janela que já reiniciou não conta para a folga', async () => {
  const dir = quotaDir();
  const now = Date.now();
  // Os números reais que expuseram o defeito: uma captura de 11h atrás com a
  // janela de 5h a 83%, já reiniciada desde então, e a de 7 dias a 23% ainda
  // a correr. A leitura ingénua anunciava 17% de folga; a conta estava a 77%,
  // como a captura seguinte confirmou.
  writeQuotaBuckets(dir, 'principal', {
    capturedAtMs: now - 11 * 3600_000,
    buckets: {
      '5h': { usedPercent: 83, resetsAtMs: now - 3600_000 },
      '7d': { usedPercent: 23, resetsAtMs: now + 5 * 24 * 3600_000 },
    },
  });
  const workers = await discoverWorkers({
    env: { AGY_QUOTA_CACHE_DIR: dir }, path: '/fake', now, probe: available('agy'),
  });
  assert.equal(workers.find((worker) => worker.bin === 'agy').quotaSlack, 77);
});

test('a janela mais apertada ainda a correr é a que manda', async () => {
  const dir = quotaDir();
  const now = Date.now();
  // O caso da conta principal: a janela curta reiniciou, mas a longa está a
  // 100% por mais dias. Tratar a reiniciada como livre daria folga total a
  // uma conta esgotada.
  writeQuotaBuckets(dir, 'principal', {
    capturedAtMs: now - 2 * 24 * 3600_000,
    buckets: {
      '5h': { usedPercent: 38, resetsAtMs: now - 2 * 24 * 3600_000 },
      '7d': { usedPercent: 100, resetsAtMs: now + 3 * 24 * 3600_000 },
    },
  });
  const workers = await discoverWorkers({
    env: { AGY_QUOTA_CACHE_DIR: dir }, path: '/fake', now, probe: available('agy'),
  });
  assert.equal(workers.find((worker) => worker.bin === 'agy').quotaSlack, 0);
});

test('todas as janelas reiniciadas dá folga desconhecida, não 100%', async () => {
  const dir = quotaDir();
  const now = Date.now();
  writeQuotaBuckets(dir, 'principal', {
    capturedAtMs: now - 8 * 3600_000,
    buckets: {
      '5h': { usedPercent: 90, resetsAtMs: now - 3600_000 },
      '7d': { usedPercent: 60, resetsAtMs: now - 600_000 },
    },
  });
  const workers = await discoverWorkers({
    env: { AGY_QUOTA_CACHE_DIR: dir }, path: '/fake', now, probe: available('agy'),
  });
  // Um contador esvaziado sugere conta livre, mas "provavelmente livre" não é
  // "livre": 100% aqui punha um worker desconhecido à frente de um com folga
  // medida.
  assert.equal(workers.find((worker) => worker.bin === 'agy').quotaSlack, null);
});

test('auto não prefere folga desconhecida a folga real', async () => {
  const dir = quotaDir();
  const now = Date.now();
  writeQuotaBuckets(dir, 'principal', {
    capturedAtMs: now - 8 * 3600_000,
    buckets: { '5h': { usedPercent: 90, resetsAtMs: now - 3600_000 } },
  });
  writeQuotaBuckets(dir, 'profile2', {
    capturedAtMs: now,
    buckets: { '7d': { usedPercent: 40, resetsAtMs: now + 3 * 24 * 3600_000 } },
  });
  const workers = await discoverWorkers({
    env: { AGY_POOL_BINS: 'agy,agy2', AGY_QUOTA_CACHE_DIR: dir },
    path: '/fake', now, probe: () => ({ available: true, version: '1.0.0' }),
  });
  assert.equal(workers.find((worker) => worker.bin === 'agy').quotaSlack, null);
  assert.equal(workers.find((worker) => worker.bin === 'agy2').quotaSlack, 60);
  assert.equal(selectWorker({ workers, activeJobs: {} }).bin, 'agy2');
});

test('auto prefere maior folga entre workers elegíveis', async () => {
  const dir = quotaDir();
  const now = Date.now();
  writeQuota(dir, 'principal', { usedPercent: 80, capturedAtMs: now }); // agy: 20% de folga
  writeQuota(dir, 'profile2', { usedPercent: 10, capturedAtMs: now }); // agy2: 90% de folga

  const workers = await discoverWorkers({
    env: { AGY_QUOTA_CACHE_DIR: dir },
    path: '/fake',
    now,
    probe: available('agy', 'agy2'),
  });

  assert.equal(selectWorker({ workers, activeJobs: {} }).id, 'agy2');
});

test('auto cai na regra de menor carga quando a folga é desconhecida ou está empatada', () => {
  const workers = [
    { id: 'agy', bin: 'agy', available: true, status: 'available', capacity: 5, quotaSlack: null },
    { id: 'agy2', bin: 'agy2', available: true, status: 'available', capacity: 5, quotaSlack: null },
  ];
  assert.equal(selectWorker({ workers, activeJobs: { agy: 3, agy2: 1 } }).id, 'agy2');

  const tied = [
    { id: 'agy', bin: 'agy', available: true, status: 'available', capacity: 5, quotaSlack: 50 },
    { id: 'agy2', bin: 'agy2', available: true, status: 'available', capacity: 5, quotaSlack: 50 },
  ];
  assert.equal(selectWorker({ workers: tied, activeJobs: { agy: 2, agy2: 0 } }).id, 'agy2');
});

test('quando todos estão a 0% de folga, auto ainda escolhe pela regra antiga', () => {
  const workers = [
    { id: 'agy', bin: 'agy', available: true, status: 'available', capacity: 5, quotaSlack: 0 },
    { id: 'agy2', bin: 'agy2', available: true, status: 'available', capacity: 5, quotaSlack: 0 },
  ];
  assert.equal(selectWorker({ workers, activeJobs: { agy: 4, agy2: 1 } }).id, 'agy2');
});
