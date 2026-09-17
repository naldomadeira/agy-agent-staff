import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverWorkers, selectWorker } from '../companion/worker-pool.mjs';

const available = (...bins) => async (bin) => {
  if (!bins.includes(bin)) throw new Error('not found');
  return { available: true, version: `${bin}-1.0.0` };
};

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
