import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceApplication } from '../scripts/workspace-ui.mjs';

const CAMPAIGN = '10000000-0000-4000-8000-000000000001';
const ENTRY = '20000000-0000-4000-8000-000000000001';
const COMMAND = '30000000-0000-4000-8000-000000000001';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.value = '';
    this.isConnected = true;
    this.listeners = new Map();
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map(child => child.textContent).join(''); }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute() {}
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  closest(selector) {
    for (let node = this.parent; node; node = node.parent) if (node.tagName === selector) return node;
    return null;
  }
  get options() { return this.children.filter(child => child.tagName === 'option'); }
  get selectedOptions() { return this.options.filter(child => child.value === this.value); }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const attribute = selector.match(/^\[data-workspace-(field|action)(?:="([^"]+)")?\]$/);
    return Boolean(attribute && (attribute[2]
      ? this.dataset[`workspace${attribute[1][0].toUpperCase()}${attribute[1].slice(1)}`] === attribute[2]
      : `workspace${attribute[1][0].toUpperCase()}${attribute[1].slice(1)}` in this.dataset));
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  async click() { await this.listeners.get('click')?.(); }
}

function command(expiresAt = Date.now() + 60_000) {
  return { id: COMMAND, campaignId: CAMPAIGN, expiresAt,
    entry: { id: ENTRY, title: 'Private artwork', type: 'scene', chapter: 'Secret chapter',
      category: 'scene', artworkFingerprint: 'a'.repeat(64),
      image: 'https://xzievefbzeyvefazppvj.supabase.co/storage/v1/object/sign/artwork/private.webp?token=synthetic' } };
}

async function popup(initial, checkAction, isAuthorized = () => true) {
  const original = Object.fromEntries(['document', 'foundry', 'game', 'ui'].map(key => [key, globalThis[key]]));
  const messages = [], mutations = [], checks = [];
  globalThis.document = { createElement: tag => new Element(tag) };
  globalThis.foundry = { applications: { api: { ApplicationV2: class {
    _onRender() {}
    async close() {}
    async minimize() { this.minimized = true; }
    async maximize() {}
  } } } };
  globalThis.game = { scenes: { contents: [{ id: 'scene-1', name: 'Map' }], current: { id: 'scene-1' } },
    actors: { contents: [{id:'actor-1',name:'Existing actor'}] } };
  globalThis.ui = { notifications: { info: value => messages.push(['info', value]),
    error: value => messages.push(['error', value]) } };
  const actions = {
    legacyPins: () => [{id:'legacy-pin'}],
    actorTypes: () => [], prefetchArtwork: async () => {},
    assertFresh: value => { if (value.expiresAt <= Date.now()) throw new Error('Request expired.'); },
    revealArtwork: async value => { mutations.push(value); },
    placePin: async value => { mutations.push(['pin', value]); return { folderStatus: 'root' }; },
    createScene: async value => { mutations.push(['scene', value]); return { name: 'Created' }; },
    attachActor: async (value, ...args) => { mutations.push(['actor', value, ...args]); return { name: 'Created' }; }
  };
  const Popup = createWorkspaceApplication(initial, actions, () => {}, isAuthorized,
    async value => { checks.push(value); return checkAction(value); });
  const app = new Popup();
  app.element = await app._renderHTML();
  app._onRender({}, {});
  await Promise.resolve();
  return {
    app, checks, messages, mutations,
    restore() {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

test('an expired delivery popup can act only after fresh command validation', async () => {
  const delivered = command(Date.now() - 1);
  const fresh = command(Date.now() + 60_000);
  const fx = await popup(delivered, async () => fresh);
  try {
    await fx.app.element.querySelector('[data-workspace-action="reveal"]').click();
    assert.deepEqual(fx.checks, [delivered]);
    assert.deepEqual(fx.mutations, [fresh]);
    assert.match(fx.app.element.querySelector('.viscanon-bridge-workspace-feedback').textContent,
      /Artwork shared/);
  } finally { fx.restore(); }
});

test('simplified popup keeps actor selection and attachment and exposes three distinct labeled pin icons',async()=>{
 const fresh=command();const fx=await popup(fresh,async()=>fresh);
 try {
  const root=fx.app.element;
  assert.equal(fx.app.constructor.DEFAULT_OPTIONS.window.title,'Viscanon');
  assert.equal(root.querySelector('[data-workspace-field="actor-search"]'),null);
  assert.equal(root.querySelector('[data-workspace-action="link-pin"]'),null);
  const actor=root.querySelector('[data-workspace-field="actor"]');
  assert.deepEqual(actor.options.map(o=>o.value),['','actor-1']);actor.value='actor-1';
  actor.listeners.get('change')();
  assert.equal(root.querySelector('[data-workspace-field="actor-type"]').closest('label').hidden,true);
  await root.querySelector('[data-workspace-action="actor"]').click();
  assert.equal(fx.mutations[0][2],'actor-1');
  const visibility=root.querySelector('[data-workspace-field="visibility"]');
  const icon=root.querySelector('.viscanon-bridge-workspace-visibility-icon'),sources=[];
  for(const choice of visibility.options){visibility.value=choice.value;visibility.listeners.get('change')();sources.push(icon.src);assert.equal(icon.alt,choice.textContent);}
  assert.equal(new Set(sources).size,3);
 }finally{fx.restore();}
});

test('a stale or unavailable command makes no Foundry mutation after an expired popup click', async () => {
  const delivered = command(Date.now() - 1);
  const fx = await popup(delivered, async () => { throw new Error('The artwork changed in Viscanon.'); });
  try {
    await fx.app.element.querySelector('[data-workspace-action="reveal"]').click();
    assert.deepEqual(fx.checks, [delivered]);
    assert.deepEqual(fx.mutations, []);
    assert.deepEqual(fx.messages, [['error', 'The artwork changed in Viscanon.']]);
    assert.equal(fx.app.element.querySelector('.viscanon-bridge-workspace-feedback').textContent,
      'The artwork changed in Viscanon.');
  } finally { fx.restore(); }
});

test('an account switch blocks an open popup before command validation or Foundry work', async () => {
  let active = true;
  const fx = await popup(command(), async value => value, () => active);
  try {
    active = false;
    await fx.app.element.querySelector('[data-workspace-action="reveal"]').click();
    assert.deepEqual(fx.checks, []);
    assert.deepEqual(fx.mutations, []);
    assert.match(fx.messages[0][1], /no longer authorized for this account/);
  } finally { fx.restore(); }
});

test('all popup choices stop before Foundry work when fresh validation fails', async () => {
  for (const choice of ['pin', 'scene', 'actor']) {
    const fx = await popup(command(Date.now() - 1), async () => {
      throw new Error('The receiver disconnected.');
    });
    try {
      await fx.app.element.querySelector(`[data-workspace-action="${choice}"]`).click();
      assert.deepEqual(fx.mutations, []);
      assert.equal(fx.app.minimized, undefined);
      assert.deepEqual(fx.messages, [['error', 'The receiver disconnected.']]);
    } finally { fx.restore(); }
  }
});

test('a mismatched validation response cannot publish artwork', async () => {
  const delivered = command(Date.now() + 60_000);
  const changed = command(Date.now() + 60_000);
  changed.entry.artworkFingerprint = 'b'.repeat(64);
  const fx = await popup(delivered, async () => changed);
  try {
    await fx.app.element.querySelector('[data-workspace-action="reveal"]').click();
    assert.deepEqual(fx.mutations, []);
    assert.match(fx.messages[0][1], /request changed/);
  } finally { fx.restore(); }
});

test('a map-only change cannot proceed from the original popup', async () => {
  const delivered = command(Date.now() + 60_000);
  delivered.entry.battlemapFingerprint = 'c'.repeat(64);
  const changed = command(Date.now() + 60_000);
  changed.entry.battlemapFingerprint = 'd'.repeat(64);
  const fx = await popup(delivered, async () => changed);
  try {
    await fx.app.element.querySelector('[data-workspace-action="reveal"]').click();
    assert.deepEqual(fx.mutations, []);
    assert.match(fx.messages[0][1], /request changed/);
  } finally { fx.restore(); }
});
