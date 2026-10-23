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
    this.attributes = new Map();
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map(child => child.textContent).join(''); }
  append(...children) {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
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

async function popup(initial, checkAction, isAuthorized = () => true, actors = [{id:'actor-1',name:'Existing actor'}]) {
  const original = Object.fromEntries(['document', 'foundry', 'game', 'ui'].map(key => [key, globalThis[key]]));
  const messages = [], mutations = [], checks = [], prefetches = [];
  globalThis.document = { createElement: tag => new Element(tag) };
  globalThis.foundry = { applications: { api: { ApplicationV2: class {
    _onRender() {}
    async close() {}
    async minimize() { this.minimized = true; }
    async maximize() {}
  } } } };
  globalThis.game = { scenes: { contents: [{ id: 'scene-1', name: 'Map' }], current: { id: 'scene-1' } },
    actors: { contents: actors } };
  globalThis.ui = { notifications: { info: value => messages.push(['info', value]),
    error: value => messages.push(['error', value]) } };
  const actions = {
    legacyPins: () => [{id:'legacy-pin'}],
    actorTypes: () => ['npc','character'], prefetchArtwork: async (...args) => { prefetches.push(args); },
    assertFresh: value => { if (value.expiresAt <= Date.now()) throw new Error('Request expired.'); },
    revealArtwork: async value => { mutations.push(value); },
    placePin: async value => { mutations.push(['pin', value]); return { folderStatus: 'root' }; },
    createScene: async value => { mutations.push(['scene', value]); return { name: 'Created' }; },
    viewScene: async value => { mutations.push(['view',value]); },
    attachActor: async (value, ...args) => { mutations.push(['actor', value, ...args]); return { name: 'Created' }; }
  };
  const Popup = createWorkspaceApplication(initial, actions, () => {}, isAuthorized,
    async value => { checks.push(value); return checkAction(value); });
  const app = new Popup();
  app.element = await app._renderHTML();
  app._onRender({}, {});
  await Promise.resolve();
  return {
    app, actions, checks, messages, mutations, prefetches,
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

test('Create scene opens the created scene locally and repeat clicks reuse it',async()=>{
 const fresh=command(),fx=await popup(fresh,async()=>fresh);
 try {
  const button=fx.app.element.querySelector('[data-workspace-action="scene"]');
  await button.click();await button.click();
  assert.equal(fx.mutations.filter(x=>x[0]==='scene').length,1);
  const views=fx.mutations.filter(x=>x[0]==='view');assert.equal(views.length,2);
  assert.equal(views[0][1],views[1][1]);assert.equal(button.textContent,'View created scene');
  assert.match(fx.messages[0][1],/opened in your view/);
 }finally{fx.restore();}
});

test('view failure retains the created scene and reports partial success without creating another',async()=>{
 const fresh=command(),fx=await popup(fresh,async()=>fresh);
 try {
  fx.actions.viewScene=async()=>{throw Error('Canvas unavailable.');};
  const button=fx.app.element.querySelector('[data-workspace-action="scene"]');
  await button.click();assert.match(fx.messages.at(-1)[1],/Scene created, but its view could not be opened/);
  await button.click();assert.equal(fx.mutations.filter(x=>x[0]==='scene').length,1);
 }finally{fx.restore();}
});

test('overlapping clicks cannot start multiple scene creations',async()=>{
 const fresh=command();let release;const waiting=new Promise(resolve=>{release=resolve;});
 const fx=await popup(fresh,async()=>{await waiting;return fresh;});
 try {
  const button=fx.app.element.querySelector('[data-workspace-action="scene"]');
  const first=button.click();await button.click();release();await first;
  assert.equal(fx.checks.length,1);assert.equal(fx.mutations.filter(x=>x[0]==='scene').length,1);
 }finally{fx.restore();}
});

test('Pin visibility label directly contains the dropdown while its preview is a sibling',async()=>{
 const fresh=command(),fx=await popup(fresh,async()=>fresh);
 try {
  const root=fx.app.element,select=root.querySelector('[data-workspace-field="visibility"]');
  const label=select.closest('label');assert.equal(label.text,'Pin visibility');
  assert.deepEqual(label.children,[select]);
  assert.equal(label.parent.children[0],root.querySelector('.viscanon-bridge-workspace-visibility-icon'));
 }finally{fx.restore();}
});

test('workspace copy is exact and the renamed actor card has no explanatory paragraph or card icons',async()=>{
 const fresh=command(),fx=await popup(fresh,async()=>fresh);
 try {
  const sections=fx.app.element.querySelectorAll('.viscanon-bridge-workspace-section');
  assert.equal(sections[0].children[1].textContent,'Show this artwork as a popup to everyone connected to Foundry and reveal in Viscanon.');
  assert.equal(sections[1].children[1].textContent,'Place a pin on the current scene. Double-click the pin to view this artwork. Click to place; Escape to cancel.');
  const actor=sections[3];assert.equal(actor.children[0].textContent,'Attach artwork to actor');
  assert.equal(actor.children.some(child=>child.tagName==='p'),false);
  for(const section of sections)assert.equal(section.children[0].tagName,'h3');
 }finally{fx.restore();}
});

test('actor modes expose only their own dropdown and sort a copied world actor list alphabetically',async()=>{
 const fresh=command(),actors=[{id:'z',name:'Zephyr'},{id:'b',name:'beta'},{id:'a2',name:'Alpha 2'},{id:'a10',name:'Alpha 10'},{id:'a1',name:'Alpha 1'}];
 const original=actors.slice(),fx=await popup(fresh,async()=>fresh,()=>true,actors);
 try {
  const root=fx.app.element,actor=root.querySelector('[data-workspace-field="actor"]'),type=root.querySelector('[data-workspace-field="actor-type"]');
  const create=root.querySelector('[data-workspace-field="actor-mode-create"]'),select=root.querySelector('[data-workspace-field="actor-mode-select"]');
  assert.equal(create.textContent,'Create new actor');assert.equal(select.textContent,'Select an actor');
  assert.equal(create.parent.getAttribute('role'),'group');assert.equal(create.parent.getAttribute('aria-label'),'Actor action');
  assert.equal(create.getAttribute('aria-pressed'),'true');assert.equal(select.getAttribute('aria-pressed'),'false');
  assert.equal(actor.closest('label').hidden,true);assert.equal(actor.disabled,true);assert.equal(type.closest('label').hidden,false);assert.equal(type.disabled,false);
  assert.deepEqual(actor.options.map(o=>o.textContent),['Choose an actor','Alpha 1','Alpha 2','Alpha 10','beta','Zephyr']);assert.deepEqual(actors,original);
  await select.click();assert.equal(actor.closest('label').hidden,false);assert.equal(actor.disabled,false);assert.equal(type.closest('label').hidden,true);assert.equal(type.disabled,true);
  assert.equal(select.getAttribute('aria-pressed'),'true');assert.equal(create.getAttribute('aria-pressed'),'false');
  assert.equal(root.querySelector('[data-workspace-action="actor"]').disabled,true);
  actor.value='b';actor.listeners.get('change')();assert.equal(root.querySelector('[data-workspace-action="actor"]').disabled,false);
  await create.click();assert.equal(actor.closest('label').hidden,true);assert.equal(type.closest('label').hidden,false);assert.equal(actor.value,'b','the choice survives a mode round-trip');
 }finally{fx.restore();}
});

test('create mode sends no existing actor id even when a prior selection is retained',async()=>{
 const fresh=command(),fx=await popup(fresh,async()=>fresh);
 try {
  const root=fx.app.element,actor=root.querySelector('[data-workspace-field="actor"]'),type=root.querySelector('[data-workspace-field="actor-type"]');
  await root.querySelector('[data-workspace-field="actor-mode-select"]').click();actor.value='actor-1';actor.listeners.get('change')();
  await root.querySelector('[data-workspace-field="actor-mode-create"]').click();type.value='character';
  await root.querySelector('[data-workspace-action="actor"]').click();
  assert.deepEqual(fx.mutations[0].slice(0,4),['actor',fresh,'','character']);
  assert.equal(fx.messages[0][1],'Actor created.');
 }finally{fx.restore();}
});

test('select mode cannot fall back to creation when the world has no actors',async()=>{
 const fresh=command(),fx=await popup(fresh,async()=>fresh,()=>true,[]);
 try {
  const root=fx.app.element;await root.querySelector('[data-workspace-field="actor-mode-select"]').click();
  assert.equal(root.querySelector('[data-workspace-field="actor"]').options[0].textContent,'No actors available');
  const button=root.querySelector('[data-workspace-action="actor"]');assert.equal(button.disabled,true);
  await button.click();assert.deepEqual(fx.mutations,[]);assert.match(fx.messages.at(-1)[1],/Choose an existing actor/);
 }finally{fx.restore();}
});

test('an in-flight actor attachment cannot change mode or target during server validation',async()=>{
 const fresh=command();let release;const waiting=new Promise(resolve=>{release=resolve;});
 const fx=await popup(fresh,async()=>{await waiting;return fresh;});
 try {
  const root=fx.app.element,actor=root.querySelector('[data-workspace-field="actor"]'),type=root.querySelector('[data-workspace-field="actor-type"]');
  const create=root.querySelector('[data-workspace-field="actor-mode-create"]'),select=root.querySelector('[data-workspace-field="actor-mode-select"]');
  await select.click();actor.value='actor-1';actor.listeners.get('change')();
  const running=root.querySelector('[data-workspace-action="actor"]').click();
  assert.equal(create.disabled,true);assert.equal(select.disabled,true);assert.equal(actor.disabled,true);assert.equal(type.disabled,true);
  await create.click();actor.value='unrelated-actor';release();await running;
  assert.equal(fx.mutations[0][2],'actor-1');assert.equal(select.getAttribute('aria-pressed'),'true');
 }finally{fx.restore();}
});

test('actor mode controls do not expose the other panel after account authorization changes',async()=>{
 let active=true;const fresh=command(),fx=await popup(fresh,async()=>fresh,()=>active);
 try {
  active=false;const root=fx.app.element;
  await root.querySelector('[data-workspace-field="actor-mode-select"]').click();
  assert.equal(root.querySelector('[data-workspace-field="actor"]').closest('label').hidden,true);
  assert.equal(root.querySelector('[data-workspace-field="actor-mode-create"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(fx.checks,[]);assert.deepEqual(fx.mutations,[]);
 }finally{fx.restore();}
});

test('simplified popup keeps actor selection and attachment and exposes three distinct labeled pin icons',async()=>{
 const fresh=command();const fx=await popup(fresh,async()=>fresh);
 try {
  const root=fx.app.element;
  assert.equal(fx.app.constructor.DEFAULT_OPTIONS.window.title,'Viscanon');
  assert.equal(root.querySelector('[data-workspace-field="actor-search"]'),null);
  assert.equal(root.querySelector('[data-workspace-action="link-pin"]'),null);
  const actor=root.querySelector('[data-workspace-field="actor"]');
  assert.deepEqual(actor.options.map(o=>o.value),['','actor-1']);
  await root.querySelector('[data-workspace-field="actor-mode-select"]').click();actor.value='actor-1';
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
