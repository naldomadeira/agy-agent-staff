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
    env: { AGY_POOL_BINS: 'agy' }, path: '/fake', config: { workers: [{ id: 'primary', bin: 'agy', capacity: 4 }] }, probe: available('agy'),
  });
  assert.equal(workers.filter((worker) => worker.bin === 'agy').length, 1);
  assert.deepEqual(workers.find((worker) => worker.bin === 'agy'), {
    id: 'primary', bin: 'agy', available: true, version: 'agy-1.0.0', capacity: 4,
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
