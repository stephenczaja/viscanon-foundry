import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const source = readFileSync(new URL('../scripts/bridge-core.mjs', import.meta.url), 'utf8');
const legacySource = process.env.VISCANON_LEGACY_REF
  ? execFileSync('git', ['show', `${process.env.VISCANON_LEGACY_REF}:scripts/bridge-core.mjs`], { encoding: 'utf8' })
  : null;
const endpoint = 'https://xzievefbzeyvefazppvj.supabase.co/functions/v1/foundry-bridge';
const code = 'a'.repeat(64);
const eventId = '20000000-0000-4000-8000-000000000001';
const fixtureOrigin = 'http://foundry.invalid';

test('native Chromium rejects the legacy receiver and pairs, polls and delivers with bound defaults', async () => {
  const browser = await chromium.launch({ headless: true, timeout: 3000 });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    const requests = [];
    const unexpected = [];
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-viscanon-token',
      'access-control-allow-methods': 'POST, OPTIONS',
      'content-type': 'application/json'
    };

    // Every network request is intercepted. The real browser fetch and timers
    // remain untouched; this test never sends a request to production Supabase.
    await page.route('**/*', async route => {
      const request = route.request();
      if (request.url() === `${fixtureOrigin}/`) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Native Foundry bridge fixture</title>' });
        return;
      }
      if (request.url() !== endpoint) {
        unexpected.push({ url: request.url(), method: request.method() });
        await route.abort('blockedbyclient');
        return;
      }
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      if (request.method() !== 'POST') {
        unexpected.push({ url: request.url(), method: request.method() });
        await route.abort('blockedbyclient');
        return;
      }
      const body = request.postDataJSON();
      requests.push({ body, token: request.headers()['x-viscanon-token'] });
      const now = Date.now();
      const event = {
        id: eventId, sequence: '1', type: 'memory',
        campaignId: '10000000-0000-4000-8000-000000000001',
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
        item: { id: `memory-${eventId}`, type: 'memory', title: 'Native browser delivery',
          image: 'https://app.viscanon.com/assets/native-receiver-test.webp' }
      };
      const data = body.action === 'bootstrap' ? { connected: true, cursor: '0' }
        : body.action === 'poll' ? { events: [event], cursor: '1', hasMore: false, pollAfterMs: 3000 }
          : body.action === 'event' && body.id === eventId ? { event } : null;
      if (!data) unexpected.push({ action: body.action });
      await route.fulfill({ status: data ? 200 : 400, headers: cors, body: JSON.stringify(data ?? { error: 'Unexpected fixture request' }) });
    });
    await page.goto(`${fixtureOrigin}/`, { waitUntil: 'domcontentloaded', timeout: 3000 });

    const nativeFunctions = await page.evaluate(() => Object.fromEntries(
      ['fetch', 'setTimeout', 'clearTimeout'].map(name => [name, Function.prototype.toString.call(globalThis[name])])
    ));
    for (const [name, implementation] of Object.entries(nativeFunctions)) {
      assert.match(implementation, /\[native code\]/, `${name} must be the genuine browser implementation`);
    }

    if (legacySource) {
      const failed = await page.evaluate(async ({ moduleSource, code }) => {
        const url = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
        let bridge;
        try {
          const { BridgeController } = await import(url);
          bridge = new BridgeController({ getConfig: () => ({ token: '', checkpoint: {} }), isCoordinator: () => true,
            saveCheckpoint: async () => {}, broadcast: () => {}, display: async () => {} });
          try {
            await bridge.testCode(code);
            return { failed: false };
          } catch (error) {
            return { failed: true, name: error.name, message: error.message };
          }
        } finally {
          bridge?.destroy();
          URL.revokeObjectURL(url);
        }
      }, { moduleSource: legacySource, code });
      assert.equal(failed.failed, true, 'the frozen legacy module must reproduce the browser failure');
      assert.equal(failed.name, 'TypeError');
      assert.match(failed.message, /Illegal invocation/i);
      assert.equal(requests.length, 0, 'the legacy invocation fails before any bridge request');
    }

    const result = await page.evaluate(async ({ moduleSource, code, eventId }) => {
      const url = URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' }));
      const config = { token: '', checkpoint: {} };
      const displayed = [];
      const packets = [];
      let bridge;
      let guard;
      try {
        const { BridgeController } = await import(url);
        let resolveConnected;
        const connected = new Promise(resolve => { resolveConnected = resolve; });
        bridge = new BridgeController({
          getConfig: () => config, isCoordinator: () => true,
          saveCheckpoint: async value => { config.checkpoint = value; },
          broadcast: packet => { packets.push(packet); }, display: async event => { displayed.push(event); },
          onStatus: status => { if (status.state === 'connected') resolveConnected(); }
        });
        const checked = await bridge.testCode(code);
        config.token = checked.token;
        config.checkpoint = checked;
        bridge.configure();
        await Promise.race([connected, new Promise((_, reject) => {
          guard = globalThis.setTimeout(() => reject(new Error('Native polling did not connect within two seconds.')), 2000);
        })]);
        globalThis.clearTimeout(guard);
        guard = undefined;
        const state = bridge.status.state;
        const scheduled = bridge.timer !== null;
        const duplicate = await bridge.receive({ type: 'artwork', id: eventId });
        bridge.destroy();
        return { checked, checkpoint: config.checkpoint, displayed, packets, duplicate, state, scheduled,
          cleanup: { timer: bridge.timer, requests: bridge.requests.size, pending: bridge.pending.size, token: bridge.token },
          nativeFunctions: Object.fromEntries(['fetch', 'setTimeout', 'clearTimeout'].map(name => [name, Function.prototype.toString.call(globalThis[name])])) };
      } finally {
        if (guard !== undefined) globalThis.clearTimeout(guard);
        bridge?.destroy();
        URL.revokeObjectURL(url);
      }
    }, { moduleSource: source, code, eventId });

    assert.deepEqual(result.checked, { token: code, cursor: '0' });
    assert.equal(result.state, 'connected');
    assert.deepEqual(result.checkpoint, { token: code, cursor: '1' });
    assert.deepEqual(requests.map(({ body }) => body.action), ['bootstrap', 'bootstrap', 'poll', 'event']);
    assert.ok(requests.every(request => request.token === code));
    assert.equal(requests[2].body.cursor, '0');
    assert.equal(requests[3].body.id, eventId);
    assert.equal(result.displayed.length, 1);
    assert.equal(result.displayed[0].id, eventId);
    assert.equal(result.displayed[0].title, 'Native browser delivery');
    assert.equal(result.displayed[0].imageUrl, 'https://app.viscanon.com/assets/native-receiver-test.webp');
    assert.equal(result.duplicate, true);
    assert.deepEqual(result.packets, [{ type: 'artwork', id: eventId }]);
    assert.equal(result.scheduled, true, 'polling creates a native follow-up timer before cleanup');
    assert.deepEqual(result.cleanup, { timer: null, requests: 0, pending: 0, token: '' });
    assert.deepEqual(result.nativeFunctions, nativeFunctions, 'the test leaves genuine browser fetch and timers intact');
    assert.deepEqual(unexpected, []);
  } finally {
    await browser.close();
  }
});
