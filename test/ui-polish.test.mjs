import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() { this.children = []; this.dataset = {}; this.attributes = new Map(); this.className = ''; }
  append(...elements) { this.children.push(...elements); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener() {}
  querySelectorAll(selector) {
    const matches = element => selector.startsWith('.')
      ? element.className.split(/\s+/).includes(selector.slice(1))
      : selector === '[data-bridge-action]' && element.dataset.bridgeAction !== undefined;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

test('connection success is correct on first render, resets after invalidation, and artwork keeps native popout classes', async () => {
  const keys = ['Hooks', 'game', 'foundry', 'document', 'addEventListener', 'fetch', 'ui'];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const hooks = new Map();
  const settings = new Map();
  const registrations = new Map();
  const socketHandlers = new Map();
  const rendered = [];
  const code = 'b'.repeat(64);
  const eventId = '20000000-0000-4000-8000-000000000001';
  let menu;
  let cleanup;
  try {
    globalThis.Hooks = { once: (name, callback) => hooks.set(name, callback), on: (name, callback) => hooks.set(name, callback) };
    const module = {};
    globalThis.game = {
      user: { id: 'gm', isGM: true }, users: { activeGM: { id: 'gm' } },
      modules: new Map([['viscanon-bridge', module]]),
      settings: {
        register: (_namespace, key, options) => { registrations.set(key, options); settings.set(key, options.default); },
        registerMenu: (_namespace, _key, options) => { menu = options; },
        get: (_namespace, key) => settings.get(key),
        set: async (_namespace, key, value) => { settings.set(key, value); registrations.get(key)?.onChange?.(value); }
      },
      socket: { on: (name, callback) => socketHandlers.set(name, callback), emit() {} }
    };
    class ImagePopout {
      static DEFAULT_OPTIONS = { classes: ['image-popout'] };
      constructor(options) { this.options = options; }
      async render(options) { rendered.push({ options: this.options, render: options }); }
    }
    globalThis.foundry = { applications: { api: { ApplicationV2: class { _onRender() {} } }, apps: { ImagePopout } } };
    globalThis.document = { createElement: () => new Element(), addEventListener() {} };
    globalThis.addEventListener = (name, callback) => { if (name === 'beforeunload') cleanup = callback; };
    globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
    globalThis.fetch = async (_endpoint, options) => {
      const body = JSON.parse(options.body);
      const now = Date.now();
      const data = body.action === 'bootstrap' ? { connected: true, cursor: '0' }
        : body.action === 'poll' ? { events: [], cursor: '0', hasMore: false, pollAfterMs: 60000 }
          : { event: { id: eventId, sequence: '1', type: 'memory', campaignId: '10000000-0000-4000-8000-000000000001',
            createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
            item: { id: `memory-${eventId}`, title: 'Shared memory', image: 'https://app.viscanon.com/assets/example.webp' } } };
      return { ok: true, status: 200, json: async () => data };
    };
    await import(`../scripts/viscanon-bridge.mjs?ui=${Date.now()}`);
    hooks.get('init')();
    const application = new menu.type();
    let status = (await application._renderHTML()).querySelector('.viscanon-bridge-status');
    assert.equal(status.dataset.state, 'starting');
    assert.equal(status.querySelector('.viscanon-bridge-status-check').hidden, true);
    hooks.get('ready')();
    status = (await application._renderHTML()).querySelector('.viscanon-bridge-status');
    assert.equal(status.dataset.state, 'disconnected');
    assert.equal(status.querySelector('.viscanon-bridge-status-check').hidden, true);
    await module.api.connect(code);
    for (let attempt = 0; attempt < 30 && module.api.status.state !== 'connected'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(module.api.status.state, 'connected');
    application.element = await application._renderHTML();
    status = application.element.querySelector('.viscanon-bridge-status');
    const message = status.querySelector('.viscanon-bridge-status-message');
    const check = status.querySelector('.viscanon-bridge-status-check');
    assert.equal(status.dataset.state, 'connected', 'a freshly opened settings window already reflects its connection');
    assert.equal(message.textContent, module.api.status.message);
    assert.equal(check.hidden, false);
    assert.equal(check.textContent, '✓');
    assert.equal(check.attributes.get('aria-hidden'), 'true');
    assert.equal(status.attributes.get('role'), 'status');
    application._onRender();
    await game.settings.set('viscanon-bridge', 'connectionCode', 'invalid');
    assert.equal(status.dataset.state, 'invalid');
    assert.equal(check.hidden, true, 'an invalid connection immediately clears its success indicator');
    assert.equal(message.textContent, module.api.status.message);
    assert.equal(status.querySelector('.viscanon-bridge-status-message'), message, 'status updates preserve the text and icon elements');
    await module.api.connect(code);
    socketHandlers.get('module.viscanon-bridge')({ type: 'artwork', id: eventId });
    for (let attempt = 0; attempt < 30 && !rendered.length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(rendered.length, 1);
    assert.deepEqual(rendered[0].options.classes, ['image-popout', 'viscanon-bridge-artwork']);
    assert.deepEqual(ImagePopout.DEFAULT_OPTIONS.classes, ['image-popout']);
    assert.deepEqual(rendered[0].options.window, { title: 'Shared memory' });
    assert.equal(rendered[0].options.showTitle, true);
    assert.deepEqual(rendered[0].render, { force: true });
    await module.api.disconnect();
    assert.equal(status.dataset.state, 'disconnected');
    assert.equal(check.hidden, true);
  } finally {
    cleanup?.();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
