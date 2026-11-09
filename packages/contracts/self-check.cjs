// Run after build: node self-check.cjs.
const assert = require('node:assert/strict');
const contracts = require('./dist');

async function main() {
  const statuses = ['solicitada', 'aceita', 'em_andamento', 'finalizada'];
  for (const [fromIndex, from] of statuses.entries()) {
    for (const [toIndex, to] of statuses.entries()) {
      assert.equal(contracts.canTransition(from, to), toIndex === fromIndex + 1);
    }
  }

  const calls = [];
  const channel = Object.fromEntries(
    ['assertExchange', 'assertQueue', 'bindQueue'].map(method => [
      method, async (...args) => calls.push([method, ...args]),
    ]),
  );
  await contracts.assertTopology(channel);
  assert.deepEqual(calls, [
    ['assertExchange', 'corridas', 'topic', { durable: true }],
    ['assertExchange', 'corridas.dlx', 'fanout', { durable: true }],
    ['assertQueue', 'corridas.worker.dlq', { durable: true }],
    ['bindQueue', 'corridas.worker.dlq', 'corridas.dlx', ''],
    ['assertQueue', 'corridas.worker', {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': 5,
        'x-dead-letter-exchange': 'corridas.dlx',
      },
    }],
    ['bindQueue', 'corridas.worker', 'corridas', 'corrida.*'],
  ]);

  const corrida = { id: 'ride-1', version: 2, status: 'aceita' };
  for (const result of [0, 1]) {
    const redis = { eval: async (script, ...args) => {
      assert.ok(script.includes("redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])"));
      assert.deepEqual(args, [1, 'corrida:ride-1', 2, JSON.stringify(corrida), 3600]);
      return result;
    } };
    assert.equal(await contracts.setCorridaIfNewer(redis, corrida), result === 1);
  }
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(contracts.setCorridaIfNewer({}, { id: 'ride-1', version }), RangeError);
  }
  await assert.rejects(contracts.setCorridaIfNewer({ eval: async () => {
    throw new Error('Redis unavailable');
  } }, corrida), /Redis unavailable/);
  assert.deepEqual(contracts.publishOptions({ event_id: 'event-1' }), {
    persistent: true, messageId: 'event-1',
  });
  console.log('Self-check passed: transitions, topology, publish options and Redis call contract.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
