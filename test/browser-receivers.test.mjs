import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeController } from '../scripts/bridge-core.mjs';

test('native browser defaults keep their global receiver during pairing, polling, delivery and cleanup', async () => {
  const originals = {fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout};
  const code = 'a'.repeat(64);
  const id = '20000000-0000-4000-8000-000000000001';
  const config = {token: '', checkpoint: {}};
  const timers = new Map();
  const calls = [];
  const displayed = [];
  let receiverChecks = {fetch: 0, setTimeout: 0, clearTimeout: 0};
  let bridge;
  try {
    globalThis.setTimeout = function (callback, milliseconds) {
      assert.equal(this, globalThis, 'setTimeout must use the browser global receiver');
      receiverChecks.setTimeout++;
      const timer = Symbol('timer');
      timers.set(timer, {callback, milliseconds});
      return timer;
    };
    globalThis.clearTimeout = function (timer) {
      assert.equal(this, globalThis, 'clearTimeout must use the browser global receiver');
      receiverChecks.clearTimeout++;
      timers.delete(timer);
    };
    globalThis.fetch = async function (_endpoint, options) {
      assert.equal(this, globalThis, 'fetch must use the browser global receiver');
      receiverChecks.fetch++;
      const body = JSON.parse(options.body);
      calls.push(body.action);
      const now = Date.now();
      const value = body.action === 'bootstrap' ? {connected: true, cursor: '0'}
        : body.action === 'poll' ? {events: [], cursor: '0', hasMore: false}
        : {event: {id, sequence: '1', type: 'memory', campaignId: '10000000-0000-4000-8000-000000000001',
          createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
          item: {id: 'memory-' + id, title: 'Receiver regression', image: 'https://app.viscanon.com/assets/example.webp'}}};
      return {ok: true, status: 200, json: async () => value};
    };
    bridge = new BridgeController({
      getConfig: () => config, isCoordinator: () => true,
      saveCheckpoint: async value => {config.checkpoint = value;},
      broadcast: () => {}, display: async event => {displayed.push(event);}
    });
    const checked = await bridge.testCode(code);
    assert.deepEqual(checked, {token: code, cursor: '0'});
    config.token = checked.token;
    config.checkpoint = checked;
    bridge.configure();
    await bridge.tick();
    assert.equal(bridge.status.state, 'connected');
    assert.equal(await bridge.receive({type: 'artwork', id}), true);
    assert.equal(await bridge.receive({type: 'artwork', id}), true);
    assert.equal(displayed.length, 1);
    assert.deepEqual(calls, ['bootstrap', 'bootstrap', 'poll', 'event']);
    bridge.destroy();
    assert.equal(timers.size, 0);
    assert.ok(Object.values(receiverChecks).every(count => count > 0));
  } finally {
    bridge?.destroy();
    Object.assign(globalThis, originals);
  }
});
