import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const runtime = readFileSync(new URL('../scripts/viscanon-bridge.mjs', import.meta.url), 'utf8');
const core = readFileSync(new URL('../scripts/bridge-core.mjs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles/bridge.css', import.meta.url), 'utf8');
const origin = 'http://foundry-ui.invalid';
const endpoint = 'https://xzievefbzeyvefazppvj.supabase.co/functions/v1/foundry-bridge';
const code = 'c'.repeat(64);
const eventIds = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'];
const asset = shape => `https://app.viscanon.com/assets/browser-ui-${shape}.webp`;

// A DOM fixture for the public ApplicationV2/ImagePopout APIs and their framed
// image/figure structure. This is a native browser style check, not a licensed
// Foundry acceptance test or a copy of Foundry's private implementation.
function fixtureSetup() {
  const callbacks = new Map(), values = new Map(), registrations = new Map(), sockets = new Map();
  const module = {};
  let menu;
  class ApplicationV2 {
    _onRender() {}
    _onClose() {}
    async render() {
      this.element = document.createElement('section');
      this.element.className = `application ${this.constructor.DEFAULT_OPTIONS.classes.join(' ')}`;
      this.element.style.width = '440px';
      this.element.innerHTML = '<header class="window-header">Viscanon</header><div class="window-content"></div>';
      this._replaceHTML(await this._renderHTML(), this.element.querySelector('.window-content'));
      document.body.append(this.element);
      this._onRender();
      return this;
    }
  }
  class ImagePopout {
    static DEFAULT_OPTIONS = { classes: ['image-popout'], window: { resizable: true } };
    constructor(options) { this.options = options; }
    async render() {
      this.element = document.createElement('section');
      this.element.className = `application ${(this.options.classes ?? ImagePopout.DEFAULT_OPTIONS.classes).join(' ')}`;
      const portrait = this.options.src.includes('portrait');
      Object.assign(this.element.style, { width: portrait ? '270px' : '640px', height: '400px' });
      const header = document.createElement('header');
      header.className = 'window-header';
      header.textContent = this.options.window?.title ?? 'Ordinary image';
      const content = document.createElement('div');
      content.className = 'window-content';
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
      image.src = this.options.src;
      figure.append(image); content.append(figure);
      const resize = document.createElement('div'); resize.className = 'window-resize';
      this.element.append(header, content, resize);
      document.body.append(this.element);
      await loaded;
      return this;
    }
  }
  globalThis.Hooks = { once: (name, callback) => callbacks.set(name, callback), on() {} };
  globalThis.foundry = { applications: { api: { ApplicationV2 }, apps: { ImagePopout } } };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.game = {
    user: { id: 'gm', isGM: true }, users: { activeGM: { id: 'gm' } }, modules: new Map([['viscanon-bridge', module]]),
    socket: { on: (name, callback) => sockets.set(name, callback), emit() {} },
    settings: {
      register: (_namespace, key, options) => { registrations.set(key, options); values.set(key, options.default); },
      registerMenu: (_namespace, _key, options) => { menu = options; },
      get: (_namespace, key) => values.get(key),
      set: async (_namespace, key, value) => { values.set(key, value); registrations.get(key)?.onChange?.(value); }
    }
  };
  globalThis.fixture = { callbacks, sockets, module, get Settings() { return menu.type; } };
}

test('native browser renders connected status and scoped artwork spacing without altering ordinary popouts', async () => {
  const browser = await chromium.launch({ headless: true, timeout: 3000 });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    page.setDefaultTimeout(3000);
    const unexpected = [];
    const baseStyles = `body{margin:0;font:16px Arial;color:#ddd;background:#111}
      .application{position:relative;display:flex;flex-direction:column;box-sizing:border-box;background:#222}
      .application .window-header{height:40px;min-height:40px;box-sizing:border-box;padding:10px 12px}
      .application .window-content{display:flex;flex-direction:column;flex:1;min-height:0;box-sizing:border-box;padding:16px}
      .image-popout figure{display:flex;flex:1;min-height:0;min-width:0;align-items:center;justify-content:center;margin:16px 40px;padding:0}
      .image-popout img{box-sizing:border-box;max-width:100%;max-height:100%;object-fit:contain;border:1px solid #999}
      .window-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize}`;
    const html = `<!doctype html><style>${baseStyles}\n${styles}</style><script>(${fixtureSetup.toString()})();</script><script type="module" src="/scripts/viscanon-bridge.mjs"></script>`;
    await page.route('**/*', async route => {
      const request = route.request(), url = request.url();
      if (url === `${origin}/`) return route.fulfill({ contentType: 'text/html', body: html });
      if (url === `${origin}/scripts/viscanon-bridge.mjs`) return route.fulfill({ contentType: 'text/javascript', body: runtime });
      if (url === `${origin}/scripts/bridge-core.mjs`) return route.fulfill({ contentType: 'text/javascript', body: core });
      if (url === `${origin}/modules/viscanon-bridge/assets/viscanon-mark-white.svg`) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="81"/>' });
      if ([asset('wide'), asset('portrait')].includes(url)) {
        const dimensions = url.includes('portrait') ? 'width="360" height="480"' : 'width="640" height="360"';
        return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" ${dimensions}><rect width="100%" height="100%" fill="#abc"/></svg>` });
      }
      if (url === endpoint) {
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-viscanon-token', 'access-control-allow-methods': 'POST,OPTIONS', 'content-type': 'application/json' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const body = request.postDataJSON(), now = Date.now();
        const index = eventIds.indexOf(body.id);
        const data = body.action === 'bootstrap' ? { connected: true, cursor: '0' }
          : body.action === 'poll' ? { events: [], cursor: '0', hasMore: false, pollAfterMs: 60000 }
            : body.action === 'event' && index >= 0 ? { event: { id: body.id, sequence: String(index + 1), type: 'memory',
              campaignId: '10000000-0000-4000-8000-000000000001', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
              item: { id: `memory-${body.id}`, title: index ? 'Portrait artwork' : 'Wide artwork', image: asset(index ? 'portrait' : 'wide') } } } : null;
        if (!data) unexpected.push(body.action);
        return route.fulfill({ status: data ? 200 : 400, headers, body: JSON.stringify(data) });
      }
      unexpected.push(url);
      return route.abort('blockedbyclient');
    });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 3000 });
    await page.evaluate(async code => {
      fixture.callbacks.get('init')(); fixture.callbacks.get('ready')();
      await fixture.module.api.connect(code);
    }, code);
    await page.waitForFunction(() => fixture.module.api.status.state === 'connected', null, { timeout: 2000 });
    await page.evaluate(async () => { fixture.settings = new fixture.Settings(); await fixture.settings.render(); });
    const success = await page.locator('.viscanon-bridge-status').evaluate(element => {
      const message = element.querySelector('.viscanon-bridge-status-message'), check = element.querySelector('.viscanon-bridge-status-check');
      return { state: element.dataset.state, background: getComputedStyle(element).backgroundColor, hidden: check.hidden,
        color: getComputedStyle(check).color, iconLeft: check.getBoundingClientRect().left, textRight: message.getBoundingClientRect().right,
        rightInset: element.getBoundingClientRect().right - check.getBoundingClientRect().right, ariaHidden: check.getAttribute('aria-hidden') };
    });
    assert.equal(success.state, 'connected');
    assert.equal(success.background, 'rgba(74, 163, 94, 0.14)');
    assert.equal(success.color, 'rgb(101, 183, 125)');
    assert.equal(success.hidden, false); assert.equal(success.ariaHidden, 'true');
    assert.ok(success.iconLeft >= success.textRight + 11, 'the green check is to the right of the status text');
    assert.ok(Math.abs(success.rightInset - 10) < 1, 'the check aligns with the container right padding');
    await page.evaluate(() => fixture.module.api.disconnect());
    const reset = await page.locator('.viscanon-bridge-status').evaluate(element => ({ state: element.dataset.state,
      background: getComputedStyle(element).backgroundColor, hidden: element.querySelector('.viscanon-bridge-status-check').hidden,
      display: getComputedStyle(element.querySelector('.viscanon-bridge-status-check')).display }));
    assert.deepEqual(reset, { state: 'disconnected', background: 'rgba(127, 127, 127, 0.12)', hidden: true, display: 'none' });
    await page.evaluate(async ({ code, eventIds, ordinaryAsset }) => {
      await fixture.module.api.connect(code);
      await new foundry.applications.apps.ImagePopout({ classes: ['image-popout', 'ordinary-popout'], src: ordinaryAsset }).render();
      for (const id of eventIds) fixture.sockets.get('module.viscanon-bridge')({ type: 'artwork', id });
    }, { code, eventIds, ordinaryAsset: asset('wide') });
    await page.waitForFunction(() => document.querySelectorAll('.viscanon-bridge-artwork img').length === 2
      && [...document.querySelectorAll('.viscanon-bridge-artwork img')].every(image => image.complete && image.naturalWidth > 0), null, { timeout: 2000 });
    const metrics = await page.locator('.image-popout').evaluateAll(elements => elements.map(element => {
      const content = element.querySelector('.window-content'), figure = element.querySelector('figure'), image = element.querySelector('img');
      const css = node => ({ padding: getComputedStyle(node).padding, margin: getComputedStyle(node).margin });
      const rect = image.getBoundingClientRect();
      return { owned: element.classList.contains('viscanon-bridge-artwork'), content: css(content), figure: css(figure), image: css(image),
        imageRatio: rect.width / rect.height, naturalRatio: image.naturalWidth / image.naturalHeight, fit: getComputedStyle(image).objectFit,
        headerHeight: element.querySelector('.window-header').getBoundingClientRect().height, resize: !!element.querySelector('.window-resize'),
        flush: Math.abs(rect.width - content.getBoundingClientRect().width) < 1 && Math.abs(rect.height - content.getBoundingClientRect().height) < 1 };
    }));
    const ordinary = metrics.find(metric => !metric.owned);
    assert.equal(ordinary.content.padding, '16px'); assert.equal(ordinary.figure.margin, '16px 40px');
    for (const metric of metrics.filter(metric => metric.owned)) {
      for (const part of [metric.content, metric.figure, metric.image]) assert.deepEqual(part, { padding: '0px', margin: '0px' });
      assert.equal(metric.fit, 'contain'); assert.ok(Math.abs(metric.imageRatio - metric.naturalRatio) < 0.005);
      assert.equal(metric.headerHeight, ordinary.headerHeight); assert.equal(metric.resize, true); assert.equal(metric.flush, true);
    }
    const resized = await page.locator('.viscanon-bridge-artwork').first().evaluate(element => {
      Object.assign(element.style, { width: '500px', height: '540px' });
      const image = element.querySelector('img'), rect = image.getBoundingClientRect();
      return { ratio: rect.width / rect.height, naturalRatio: image.naturalWidth / image.naturalHeight, fit: getComputedStyle(image).objectFit };
    });
    assert.ok(Math.abs(resized.ratio - resized.naturalRatio) < 0.005, 'resizing preserves artwork proportions');
    assert.equal(resized.fit, 'contain', 'resizing retains the full image instead of cropping');
    assert.deepEqual(unexpected, []);
  } finally { await browser.close(); }
});
