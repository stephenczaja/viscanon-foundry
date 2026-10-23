import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceController } from '../scripts/workspace-core.mjs';
import { createPinPlacement, styleWorkspaceNote } from '../scripts/workspace-pin.mjs';
import { createWorkspaceActions, PIN_ICON, PIN_ICONS, PIN_VISIBILITY, entryDocumentName } from '../scripts/workspace-actions.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function surface() {
  const listeners = new Map();
  return { listeners, style: { cursor: 'default' },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    fire(name, values = {}) { listeners.get(name)?.({ preventDefault() {}, stopImmediatePropagation() {}, ...values }); }
  };
}
function placementFixture() {
  const view = surface(), doc = surface(), previews = [], subscriptions = new Map();
  doc.createElement = () => ({ style: {}, children: [], append(...values) {this.children.push(...values);}, remove() { this.removed = true; } });
  doc.body = { append: value => previews.push(value) };
  view.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300 });
  const scene = { id: 'scene', width: 800, height: 600 };
  const board = { scene, dimensions: { sceneRect: { x: 100, y: 50, width: 800, height: 600 } },
    app: { view, renderer: { width: 800, height: 600 } }, stage: { toLocal: p => ({ x: p.x + 100, y: p.y + 50 }) } };
  let active = true;
  const hooks = { on(name, fn) { subscriptions.set(name, fn); return name; }, off(name) { subscriptions.delete(name); } };
  const placement = createPinPlacement({ board, document: doc, hooks, icon: PIN_ICON,
    assertGM() { if (!active) throw new Error('GM changed.'); } });
  return { ...placement, scene, board, view, doc, previews, subscriptions, loseGM() { active = false; } };
}

test('pin preview follows the cursor; a click uses scene offsets and renderer scale, then cleans up', async () => {
  const fx = placementFixture();
  const result = fx.captureMapPoint(fx.scene);
  assert.equal(fx.view.style.cursor, 'crosshair');
  fx.view.fire('pointermove', { clientX: 150, clientY: 200 });
  assert.equal(fx.previews[0].hidden, false);
  assert.deepEqual(fx.previews[0].style, { left: '150px', top: '200px' });
  fx.view.fire('pointerdown', { clientX: 110, clientY: 120, button: 0 });
  assert.deepEqual(await result, { x: 300, y: 250 });
  assert.equal(fx.previews[0].removed, true);
  assert.equal(fx.view.style.cursor, 'default');
  assert.equal(fx.view.listeners.size + fx.doc.listeners.size + fx.subscriptions.size, 0);
});

for (const kind of ['escape', 'right-click', 'close', 'scene-change', 'account-change']) {
  test(`pin placement ${kind} cancels without a position or leftover preview`, async () => {
    const fx = placementFixture();
    const result = fx.captureMapPoint(fx.scene);
    if (kind === 'escape') fx.doc.fire('keydown', { key: 'Escape' });
    if (kind === 'right-click') fx.view.fire('contextmenu');
    if (kind === 'close') fx.cancelPinPlacement();
    if (kind === 'scene-change') fx.subscriptions.get('canvasTearDown')();
    if (kind === 'account-change') { fx.loseGM(); fx.subscriptions.get('updateUser')(); }
    assert.equal(await result, null);
    assert.equal(fx.previews[0].removed, true);
    assert.equal(fx.view.listeners.size + fx.doc.listeners.size + fx.subscriptions.size, 0);
  });
}

test('pin placement never switches scenes; an out-of-bounds click can be corrected', async () => {
  const fx = placementFixture();
  assert.throws(() => fx.captureMapPoint({ id: 'other' }), /Open a map/);
  const result = fx.captureMapPoint(fx.scene);
  fx.view.fire('pointerdown', { clientX: -100, clientY: -100, button: 0 });
  assert.equal(fx.previews[0].removed, undefined);
  fx.view.fire('pointerdown', { clientX: 10, clientY: 20, button: 0 });
  assert.deepEqual(await result, { x: 100, y: 50 });
});

test('transparent note styling changes only Viscanon note decorations', () => {
  const other = { document: { flags: {} }, controlIcon: { bg: { visible: true }, border: { visible: true } } };
  styleWorkspaceNote(other);
  assert.equal(other.controlIcon.bg.visible, true);
  const ours = structuredClone(other);
  ours.document.flags['viscanon-bridge'] = { mapPin: true };
  styleWorkspaceNote(ours);
  assert.equal(ours.controlIcon.bg.visible, false);
  assert.equal(ours.controlIcon.border.visible, false);
});

function actionFixture() {
  const before = Object.fromEntries(['document', 'CONFIG', 'ui', 'canvas'].map(key => [key, globalThis[key]]));
  const fx = placementFixture(), journals = [], uploads = [], popouts = [], notifications = [], actorUpdates = [], createdScenes = [], requestedImages = [];
  globalThis.document = fx.doc;
  globalThis.ui = { notifications: { error: text => notifications.push(text), info() {} } };
  let currentRevealed = false, beforeUpload = () => {}, beforeCheck = () => {}, beforePinRead = () => {};
  const pinReads = [], journalUpdates = [], instances = [], dialogs = [];
  let dialogAnswer = null;
  const command = { id: 'command', campaignId: 'campaign', expiresAt: Date.now() + 90_000,
    entry: { id: 'entry', type: 'location', title: 'Secret village', chapter: '', category: 'location',
      artworkFingerprint: 'a'.repeat(64), battlemapFingerprint: null, revealed: false,
      image: 'https://xzievefbzeyvefazppvj.supabase.co/storage/v1/object/sign/artwork/test.png?token=synthetic' } };
  const actor = { id: 'actor', name: 'Player actor', testUserPermission: () => true,
    async update(data) { actorUpdates.push(data); } };
  const world = { user: { id: 'gm', isGM: true }, users: { activeGM: { id: 'gm' }, contents: [{ id: 'player', isGM: false }] },
    release: {generation:14}, actors: { get: () => actor }, folders: { contents: [] }, journal: { contents: journals, get: id => journals.find(j => j.id === id) },
    scenes: { get: id => id === fx.scene.id ? fx.scene : null } };
  fx.scene.createEmbeddedDocuments = async (_, data) => data;
  globalThis.CONFIG = {
    Scene: { documentClass: {create: async data => {createdScenes.push(data);return data;}}},
    Folder: { documentClass: { create: async data => { const folder={id:'folder-'+world.folders.contents.length,...data};world.folders.contents.push(folder);return folder;} } },
    JournalEntry: { documentClass: { create: async data => {
      const journal = { ...data, id: 'journal', async update(patch) {
        journalUpdates.push(patch);
        for (const [key,value] of Object.entries(patch)) {
          const parts=key.split('.'); let target=this;
          for(const part of parts.slice(0,-1)) target=target[part]??={};
          target[parts.at(-1)]=value;
        }
      }, pages: { contents: data.pages.map(p => ({ ...p, id: 'page' })) } };
      journals.push(journal); return journal;
    } } }
  };
  class ImagePopout {
    constructor(options) { this.options = options; popouts.push(this); }
    async render() { return this; }
    async close() { this._onClose?.({}); }
    _onClose() {}
  }
  const makeActions = ({ nativeCanvas = false } = {}) => { const actions = createWorkspaceActions({ game: world, ...(!nativeCanvas ? {canvas: fx.board} : {}),
    foundry: { applications: { apps: { ImagePopout }, api: { DialogV2: { async input(options) {dialogs.push(options);return dialogAnswer;} } } } },
    checkAction: async proof => { await beforeCheck(); return { ...command, id: proof.id, entry: { ...command.entry, revealed: currentRevealed } }; },
    fetchPinArtwork: async proof => { pinReads.push(proof); await beforePinRead(pinReads.length); return {...command,entry:{...command.entry,revealed:currentRevealed}}; },
    filePicker: { uploadPersistent: async (...args) => { uploads.push(args); beforeUpload(); return { path: 'persistent/art.png' }; } },
    imageBitmap: async () => ({ width: 800, height: 400, close() {} }),
    fetchImpl: async url => {requestedImages.push(url);return { ok: true, headers: { get: () => 'image/png' }, blob: async () => new Blob(['test'], { type: 'image/png' }) };}
  }); instances.push(actions); return actions; };
  const actions=makeActions();
  return { ...fx, actions, makeActions, pinReads, journalUpdates, dialogs, command, world, journals, uploads, popouts, notifications, actorUpdates, createdScenes, requestedImages,
    reveal(value) { currentRevealed = value; }, onUpload(fn) { beforeUpload = fn; },
    answerDialog(value) {dialogAnswer=value;}, onCheck(fn) { beforeCheck=fn; }, onPinRead(fn) { beforePinRead=fn; },
    restore() { instances.forEach(actions=>actions.destroy()); for (const [key, value] of Object.entries(before)) globalThis[key] = value; } };
}

for (const start of ['same-scene', 'switched-scene', 'before-canvas-ready', 'replaced-canvas']) {
  test(`pin placement uses the current native canvas: ${start}`, async () => {
    const fx=actionFixture();
    try {
      globalThis.canvas=start==='before-canvas-ready' ? undefined : fx.board;
      const actions=fx.makeActions({nativeCanvas:true});
      const notes=[];
      const scene={...fx.scene,id:['replaced-canvas','switched-scene'].includes(start)?'new-scene':fx.scene.id,
        async createEmbeddedDocuments(_type,data){notes.push(...data);return data;}};
      fx.world.scenes.get=id=>id===scene.id?scene:null;
      if (['same-scene','switched-scene'].includes(start)) {
        fx.board.scene=scene;globalThis.canvas=fx.board;
      } else globalThis.canvas={...fx.board,scene};
      const pending=actions.placePin(fx.command,scene.id,'gm_only');
      const outcome=pending.then(value=>({value}),error=>({error}));
      fx.view.fire('pointerdown',{clientX:110,clientY:120});
      const result=await outcome;
      assert.equal(result.error,undefined,result.error?.message);
      assert(result.value);assert.equal(notes.length,1);
      assert.deepEqual({x:notes[0].x,y:notes[0].y},{x:300,y:250});
      assert.equal(fx.uploads.length,0,'private placement never uploads artwork');
      assert.equal(fx.journals[0].ownership.default,0);
    } finally {fx.restore();}
  });
}

test('a scene switch after the placement click rejects stale coordinates before document creation',async()=>{
  const fx=actionFixture();
  try {
    let notes=0;fx.scene.createEmbeddedDocuments=async()=>{notes++;return [{}];};
    fx.onCheck(()=>{fx.board.scene={id:'switched-scene'};});
    const pending=fx.actions.placePin(fx.command,fx.scene.id,'gm_only');
    fx.view.fire('pointerdown',{clientX:110,clientY:120});
    await assert.rejects(pending,/scene|map/i);
    assert.equal(notes,0);assert.equal(fx.journals.length,0);assert.equal(fx.uploads.length,0);
  }finally{fx.restore();}
});

for (const reason of ['cancel','scene-switch-before-click']) {
  test(`pin placement ${reason} leaves no journal, upload or existing-pin change`,async()=>{
    const fx=actionFixture();
    try {
      let writes=0;fx.scene.createEmbeddedDocuments=async()=>{writes++;return [{}];};
      const pending=fx.actions.placePin(fx.command,fx.scene.id,'gm_only');
      if(reason==='cancel')fx.actions.cancelPinPlacement();
      else {fx.board.scene={id:'other'};fx.view.fire('pointerdown',{clientX:110,clientY:120});}
      assert.equal(await pending,null);assert.equal(writes,0);assert.equal(fx.journals.length,0);assert.equal(fx.uploads.length,0);
      assert.equal(fx.view.listeners.size,0);
    }finally{fx.restore();}
  });
}

test('late scene switch rolls back only the new Note and journal, preserving existing pins',async()=>{
  const fx=actionFixture();
  try {
    const existing={id:'existing-note'},notes=[existing],removed=[];
    const create=CONFIG.JournalEntry.documentClass.create;
    CONFIG.JournalEntry.documentClass.create=async data=>{
      const journal=await create(data);journal.delete=async()=>{journal.deleted=true;};return journal;
    };
    fx.scene.createEmbeddedDocuments=async(_type,data)=>{
      const note={...data[0],id:'new-note'};notes.push(note);fx.board.scene={id:'other'};return[note];
    };
    fx.scene.deleteEmbeddedDocuments=async(type,ids)=>{
      assert.equal(type,'Note');removed.push(...ids);
      for(const id of ids)notes.splice(notes.findIndex(note=>note.id===id),1);
    };
    const pending=fx.actions.placePin(fx.command,fx.scene.id,'gm_only');
    fx.view.fire('pointerdown',{clientX:110,clientY:120});
    await assert.rejects(pending,/viewed map changed/);
    assert.deepEqual(removed,['new-note']);assert.deepEqual(notes,[existing]);
    assert.equal(fx.journals.length,1);assert.equal(fx.journals[0].deleted,true);assert.equal(fx.uploads.length,0);
  }finally{fx.restore();}
});

test('a settled placement handler cannot cancel a later placement or reuse its coordinates',async()=>{
  const fx=placementFixture();
  const first=fx.captureMapPoint(fx.scene),oldClick=fx.view.listeners.get('pointerdown');
  oldClick({clientX:110,clientY:120,preventDefault(){},stopImmediatePropagation(){}});
  assert.deepEqual(await first,{x:300,y:250});
  const second=fx.captureMapPoint(fx.scene);
  oldClick({clientX:310,clientY:220,preventDefault(){},stopImmediatePropagation(){}});
  assert.equal(fx.previews[1].removed,undefined);
  fx.view.fire('pointerdown',{clientX:60,clientY:70});
  assert.deepEqual(await second,{x:200,y:150});assert.equal(fx.previews[1].removed,true);
});

test('missing or unauthorized current scene rejects before placement, journals or artwork uploads',async()=>{
  const fx=actionFixture();
  try {
    fx.board.scene=null;
    await assert.rejects(fx.actions.placePin(fx.command,undefined,'gm_only'),/scene|map/i);
    fx.board.scene=fx.scene;fx.scene.canUserModify=()=>false;
    const denied=fx.actions.placePin(fx.command,fx.scene.id,'gm_only');
    denied.catch(()=>{});fx.actions.cancelPinPlacement();
    await assert.rejects(denied,/permission|scene|map/i);
    assert.equal(fx.view.listeners.size,0);assert.equal(fx.journals.length,0);assert.equal(fx.uploads.length,0);
  }finally{fx.restore();}
});

test('a hidden pin opens actual artwork privately for its GM; no private URL enters Foundry documents or sockets', async () => {
  const fx = actionFixture();
  try {
    const result = fx.actions.placePin(fx.command, fx.scene.id, 'gm_only');
    fx.view.fire('pointerdown', { clientX: 110, clientY: 120 });
    const placed = await result;
    assert.equal(placed.journal.pages.contents[0].src, PIN_ICON);
    assert.equal(fx.uploads.length, 0);
    const note = { entry: placed.journal, document: placed.note };
    assert.equal(fx.actions.activatePin(note), false);
    await tick();
    assert.equal(fx.popouts.length, 1);
    assert.match(fx.popouts[0].options.src, /^blob:/);
    assert.equal(fx.popouts[0].options.window.title, 'Secret village');
    assert.equal(fx.uploads.length, 0);
    assert.equal(placed.journal.name, 'Secret village');
    assert.equal(placed.journal.ownership.default, 0);
    assert.ok(!JSON.stringify({note:placed.note,flags:placed.journal.flags}).includes('Secret village'));
    assert.ok(!JSON.stringify(placed.journal).includes('token='));
    await assert.rejects(fx.popouts[0].shareImage(), /Use Reveal/);
    fx.world.user = { id: 'player', isGM: false };
    assert.equal(fx.actions.activatePin(note), undefined);
    assert.equal(fx.popouts.length, 1);
  } finally { fx.restore(); }
});

test('actor checkbox removal still blocks unrevealed player portraits and updates only img after fresh reveal', async () => {
  const fx = actionFixture();
  try {
    await assert.rejects(fx.actions.attachActor(fx.command, 'actor', '', false, true), /Reveal the artwork/);
    assert.equal(fx.uploads.length, 0);
    assert.equal(fx.actorUpdates.length, 0);
    fx.reveal(true);
    await fx.actions.attachActor(fx.command, 'actor', '', false, true);
    assert.deepEqual(fx.actorUpdates, [{ img: 'persistent/art.png' }]);
  } finally { fx.restore(); }
});

test('undo during upload prevents the actor portrait update', async () => {
  const fx = actionFixture();
  try {
    fx.reveal(true); fx.onUpload(() => fx.reveal(false));
    await assert.rejects(fx.actions.attachActor(fx.command, 'actor', '', false, true), /Reveal the artwork/);
    assert.equal(fx.actorUpdates.length, 0);
  } finally { fx.restore(); }
});


test('Create scene uses displayed artwork dimensions and creates an inactive gridless scene', async () => {
  const fx = actionFixture();
  try {
    fx.command.entry.battlemap = fx.command.entry.image.replace('test.png', 'other-map.png');
    await fx.actions.createScene(fx.command, true);
    assert.deepEqual(fx.requestedImages, [fx.command.entry.image]);
    const scene = fx.createdScenes[0];
    assert.equal(scene.width,800); assert.equal(scene.height,400);
    assert.equal(scene.grid.type,0); assert.equal(scene.padding,0);
    assert.equal(scene.navigation,false); assert.equal(scene.ownership.default,0);
    assert.equal(scene.levels[0].background.src,'persistent/art.png');
  } finally {fx.restore();}
});

for (const type of ['location','character','scene']) {
  test(`new ${type} Scene uses current canonical naming and chapter/type folders without changing existing documents`, async () => {
    const fx=actionFixture();
    try {
      const root={id:'existing-root',name:'Viscanon',type:'Scene',folder:null};
      const unrelated={id:'unrelated',name:'Old user folder',type:'Scene',folder:null};
      fx.world.folders.contents.push(root,unrelated);
      Object.assign(fx.command.entry,{type,category:type,title:'Obsolete title',entryName:'Haunted House',sceneNumber:type==='scene'?'A1':'',chapter:'The Coast',chapterId:'10000000-0000-4000-8000-000000000008'});
      const before=structuredClone([root,unrelated]);
      const created=await fx.actions.createScene(fx.command,true);
      assert.equal(created.name,type==='scene'?'A1: Haunted House':'Haunted House');
      assert.equal(created.navName,'Haunted House');
      assert.equal(Boolean(created.flags['viscanon-bridge'].numberedName),type==='scene');
      const category=fx.world.folders.contents.find(f=>f.id===created.folder);
      assert.equal(category.name,{location:'Locations',character:'Characters',scene:'Scenes'}[type]);
      const chapter=fx.world.folders.contents.find(f=>f.id===category.folder);
      assert.equal(chapter.name,'The Coast');assert.equal(chapter.folder,root.id);
      assert.deepEqual([root,unrelated],before);
      await fx.actions.createScene(fx.command,true);
      assert.equal(fx.world.folders.contents.length,4,'reuse the same chapter/type folders');
      assert.equal(created.ownership.default,0);assert.equal(created.navigation,false);
    } finally {fx.restore();}
  });
}

test('missing chapter and scene number create no invented labels or prefix',async()=>{
  const fx=actionFixture();
  try {
    Object.assign(fx.command.entry,{type:'scene',category:'scene',entryName:'Arrival',sceneNumber:'',chapter:''});
    const created=await fx.actions.createScene(fx.command,true);
    assert.equal(created.name,'Arrival');
    assert.deepEqual(fx.world.folders.contents.map(f=>f.name),['Viscanon','Scenes']);
    assert.equal(entryDocumentName({type:'location',entryName:'Harbor',sceneNumber:'99'}),'Harbor');
  } finally {fx.restore();}
});

test('viewScene uses only the local document view and fences authority changes',async()=>{
 const fx=actionFixture();let views=0;
 const otherUsers=[{id:'player',viewedScene:'old'},{id:'other-gm',viewedScene:'old'}];
 const scene={async view(){views++;},activate(){throw Error('must not activate');},pullUsers(){throw Error('must not pull');}};
 try {
  await fx.actions.viewScene(scene);assert.equal(views,1);
  assert.deepEqual(otherUsers.map(u=>u.viewedScene),['old','old']);
  fx.world.user={id:'different-gm',isGM:true};
  await assert.rejects(fx.actions.viewScene(scene),/Only the active GM/);assert.equal(views,1);
  fx.world.user={id:'gm',isGM:false};await assert.rejects(fx.actions.viewScene(scene),/Only the active GM/);
 }finally{fx.restore();}
});

test('new actors use the fresh entry name without a scene prefix; existing actors keep their names',async()=>{
 const fx=actionFixture(),created=[];
 try {
  fx.world.documentTypes={Actor:['npc']};
  globalThis.CONFIG.Actor={documentClass:{async create(data){created.push(data);return data;}}};
  Object.assign(fx.command.entry,{type:'scene',sceneNumber:'19',title:'Artwork revision name',entryName:'Canonical entry'});
  fx.onCheck(()=>{fx.command.entry.entryName='Fresh entry name';});
  await fx.actions.attachActor(fx.command,'','npc',false,true);
  assert.equal(created[0].name,'Fresh entry name');assert.equal(created[0].ownership.default,0);
  fx.reveal(true);await fx.actions.attachActor(fx.command,'actor','',false,true);
  assert.deepEqual(fx.actorUpdates,[{img:'persistent/art.png'}]);
 }finally{fx.restore();}
});

for(const visibility of Object.values(PIN_VISIBILITY)) {
  test(`${visibility} pin uses distinct cursor/note artwork, a named Journal and unchanged access`,async()=>{
    const fx=actionFixture();
    try {
      Object.assign(fx.command.entry,{type:'scene',category:'scene',entryName:'Arrival',sceneNumber:'2'});
      const pending=fx.actions.placePin(fx.command,fx.scene.id,visibility);
      assert.equal(fx.previews[0].src,PIN_ICONS[visibility]);assert.ok(fx.previews[0].alt);
      fx.view.fire('pointerdown',{clientX:110,clientY:120});const placed=await pending;
      assert.equal(placed.note.texture.src,PIN_ICONS[visibility]);
      assert.equal(placed.journal.name,'2: Arrival');assert.equal(placed.journal.pages.contents[0].name,'2: Arrival');
      assert.equal(placed.journal.ownership.default,visibility==='visible'?2:0);
      assert.equal(placed.journal.pages.contents[0].ownership.default,visibility==='visible'?2:0);
      assert.ok(!JSON.stringify({note:placed.note,flags:placed.journal.flags}).includes('Arrival'));
      assert.equal(fx.uploads.length,visibility==='visible'?1:0);
    } finally {fx.restore();}
  });
}

test('receiver posts a fresh dual-capability reveal and rejects a response after session change', async () => {
  const controller = new WorkspaceController({getConfig:()=>({}),isCoordinator:()=>true,openCommand:async()=>{}});
  const command = {id:'command',campaignId:'campaign',entry:{id:'entry',type:'location',artworkFingerprint:'a'.repeat(64)}};
  controller.checkAction = async () => command; controller.session='session'; controller.generation=1;
  const receipt={revealed:true,eventId:'40000000-0000-4000-8000-000000000001',campaignId:'campaign',entryId:'entry'};
  controller.request=async body=>{assert.equal(body.action,'workspace-reveal');assert.equal(body.session,'session');
    assert.match(body.revealId,/^[a-f0-9-]{36}$/);assert.equal(body.artworkFingerprint,command.entry.artworkFingerprint);return receipt;};
  assert.deepEqual(await controller.revealArtwork(command),receipt);
  controller.request=async()=>{controller.session='other';return receipt;};
  await assert.rejects(controller.revealArtwork(command),/connection changed/);
});

for (const recovery of ['receiver reconnect', 'browser reload', 'world restart']) {
  test(`hidden pin opens its persisted artwork after ${recovery} without another Send`, async () => {
    const fx=actionFixture();
    try {
      const pending=fx.actions.placePin(fx.command,fx.scene.id,'gm_only');
      fx.view.fire('pointerdown',{clientX:110,clientY:120});
      const placed=await pending;
      const stored=JSON.parse(JSON.stringify({journal:placed.journal,note:placed.note}));
      fx.actions.destroy();
      fx.command.id='different-or-expired-command';
      fx.command.expiresAt=0;
      fx.onCheck(()=>{throw Error('The old Send receipt is unavailable');});
      if(recovery!=='receiver reconnect') fx.journals.splice(0,1,stored.journal);
      const actions=fx.makeActions();
      const note={entry:fx.journals[0],document:stored.note};
      assert.equal(actions.activatePin(note),false); await tick(); await tick();
      assert.equal(fx.notifications.length,0);
      assert.equal(fx.popouts.length,1); assert.match(fx.popouts[0].options.src,/^blob:/);
      assert.deepEqual(fx.pinReads,[0,1].map(()=>({campaignId:'campaign',entryId:'entry',fingerprint:'a'.repeat(64)})));
      assert.equal(fx.uploads.length+fx.journalUpdates.length,0);
      assert.equal(fx.journals.length,1);
      assert.equal(fx.journals[0].ownership.default,0);
      assert.equal(fx.journals[0].pages.contents[0].src,PIN_ICON);
      assert.deepEqual(JSON.parse(JSON.stringify({journal:fx.journals[0],note:stored.note})),stored);
      fx.world.user={id:'player',isGM:false};
      assert.equal(actions.activatePin(note),undefined); await tick();
      assert.equal(fx.popouts.length,1); assert.equal(fx.pinReads.length,2);
    } finally {fx.restore();}
  });
}

test('pre-existing on-reveal pin uses its stored identity without a Send receipt',async()=>{
 const fx=actionFixture();
 try{
  const journal={id:'old',ownership:{default:0},flags:{'viscanon-bridge':{visibility:'on_reveal',campaignId:'campaign',entryId:'entry',artworkFingerprint:'a'.repeat(64)}},pages:{contents:[{type:'image',src:PIN_ICON}]}};
  fx.journals.push(journal);fx.onCheck(()=>{throw Error('No receipt');});
  fx.actions.activatePin({entry:journal,document:{flags:{'viscanon-bridge':{mapPin:true}}}});
  await tick();await tick();assert.equal(fx.popouts.length,1);assert.equal(fx.uploads.length,0);
 }finally{fx.restore();}
});

for(const race of ['revocation','wrong artwork','account change','destroy'])test(`hidden pin stays closed after ${race} during retrieval`,async()=>{
 const fx=actionFixture();
 try{
  const pending=fx.actions.placePin(fx.command,fx.scene.id,'gm_only');fx.view.fire('pointerdown',{clientX:110,clientY:120});const placed=await pending;
  fx.onPinRead(n=>{if(n!==2)return;if(race==='revocation')throw Error('GM access revoked');
   if(race==='wrong artwork')fx.command.entry.artworkFingerprint='b'.repeat(64);
   if(race==='account change')fx.world.user={id:'player',isGM:false};
   if(race==='destroy')fx.actions.destroy();});
  fx.actions.activatePin({entry:placed.journal,document:placed.note});await tick();await tick();
  assert.equal(fx.popouts.length,0);assert.equal(fx.uploads.length,0);assert.equal(fx.notifications.length,1);
 }finally{fx.restore();}
});

for(const outcome of ['success','revoked','pin changed','invalid choice'])test(`legacy pin in-place linking: ${outcome}`,async()=>{
 const fx=actionFixture();
 try{
  const pending=fx.actions.placePin(fx.command,fx.scene.id,'gm_only');fx.view.fire('pointerdown',{clientX:110,clientY:120});const placed=await pending;
  const flags=placed.journal.flags['viscanon-bridge'];delete flags.campaignId;delete flags.entryId;delete flags.artworkFingerprint;
  const before=JSON.parse(JSON.stringify(placed));assert.equal(fx.actions.legacyPins().length,1);
  if(outcome==='revoked')fx.onCheck(()=>{throw Error('Revoked');});
  if(outcome==='pin changed')fx.onCheck(()=>{flags.visibility='visible';});
  const result=fx.actions.linkExistingPin(fx.command,outcome==='invalid choice'?'different':placed.journal.id);
  if(outcome!=='success'){await assert.rejects(result);assert.equal(fx.journalUpdates.length,0);return;}
  assert.equal(await result,placed.journal);assert.equal(fx.actions.legacyPins().length,0);
  assert.deepEqual(fx.journalUpdates,[{'flags.viscanon-bridge.campaignId':'campaign','flags.viscanon-bridge.entryId':'entry','flags.viscanon-bridge.artworkFingerprint':'a'.repeat(64)}]);
  delete placed.journal.flags['viscanon-bridge'].campaignId;delete placed.journal.flags['viscanon-bridge'].entryId;delete placed.journal.flags['viscanon-bridge'].artworkFingerprint;
  assert.deepEqual(JSON.parse(JSON.stringify(placed)),before);
  assert.equal(fx.uploads.length,0);assert.equal(fx.journals.length,1);
 }finally{fx.restore();}
});

const uuid=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function pinControllerFixture(){
 let coordinator=true,online=true;
 const controller=new WorkspaceController({getConfig:()=>({}),isCoordinator:()=>coordinator,isOnline:()=>online,openCommand:async()=>{}});
 Object.assign(controller,{initialized:true,coordinator:true,campaignId:uuid(1),session:uuid(2),generation:1});
 const proof={campaignId:uuid(1),entryId:uuid(3),fingerprint:'a'.repeat(64)};
 const entry={id:proof.entryId,type:'location',category:'location',title:'Private artwork',revealed:false,
  artworkFingerprint:proof.fingerprint,battlemapFingerprint:null,image:'https://xzievefbzeyvefazppvj.supabase.co/storage/v1/object/sign/artwork/test.png?token=synthetic'};
 const bodies=[];controller.request=async body=>{bodies.push(body);return{entry};};
 return{controller,proof,entry,bodies,loseGM(){coordinator=false;},offline(){online=false;}};
}

test('private pin retrieval uses the current receiver session after reconnect, independently of command delivery',async()=>{
 const fx=pinControllerFixture();
 for(const session of [uuid(2),uuid(4),uuid(5)]){
  fx.controller.session=session;fx.controller.generation++;
  const fresh=await fx.controller.fetchPinArtwork(fx.proof);
  assert.equal(fresh.entry.id,fx.proof.entryId);assert.equal(fresh.entry.image,fx.entry.image);
  assert.deepEqual(fx.bodies.at(-1),{action:'workspace-pin-artwork',session,...fx.proof});
 }
 assert.equal(fx.controller.delivered.size,0);
});

for(const race of ['session','generation','offline','role','not initialized','wrong fingerprint','wrong entry','unsafe image'])test(`private pin receiver rejects ${race}`,async()=>{
 const fx=pinControllerFixture();
 fx.controller.request=async()=>{
  if(race==='session')fx.controller.session=uuid(7);
  if(race==='generation')fx.controller.generation++;
  if(race==='offline')fx.offline();if(race==='role')fx.loseGM();
  if(race==='not initialized')fx.controller.initialized=false;
  if(race==='wrong fingerprint')fx.entry.artworkFingerprint='f'.repeat(64);
  if(race==='wrong entry')fx.entry.id=uuid(8);
  if(race==='unsafe image')fx.entry.image='https://evil.invalid/private.png';
  return{entry:fx.entry};
 };
 await assert.rejects(fx.controller.fetchPinArtwork(fx.proof));
});

test('wrong-campaign, inactive GM, and disconnected private pin requests never leave the browser',async()=>{
 for(const change of [fx=>fx.proof.campaignId=uuid(9),fx=>fx.loseGM(),fx=>fx.offline(),fx=>fx.controller.initialized=false]){
  const fx=pinControllerFixture();change(fx);await assert.rejects(fx.controller.fetchPinArtwork(fx.proof));assert.equal(fx.bodies.length,0);
 }
});

test('legacy pin native selection can cancel or link without replacing the Note',async()=>{
 const fx=actionFixture();
 try{
  const pending=fx.actions.placePin(fx.command,fx.scene.id,'gm_only');fx.view.fire('pointerdown',{clientX:110,clientY:120});const placed=await pending;
  const flags=placed.journal.flags['viscanon-bridge'];delete flags.campaignId;delete flags.entryId;delete flags.artworkFingerprint;
  assert.equal(await fx.actions.linkExistingPin(fx.command),null);assert.equal(fx.journalUpdates.length,0);
  assert.equal(fx.dialogs[0].window.title,'Link existing pin');assert.equal(fx.dialogs[0].content.children[1].name,'journalId');
  fx.answerDialog({journalId:placed.journal.id});await fx.actions.linkExistingPin(fx.command);
  fx.actions.destroy();fx.command.expiresAt=0;fx.onCheck(()=>{throw Error('Expired Send');});
  const actions=fx.makeActions();actions.activatePin({entry:placed.journal,document:placed.note});await tick();await tick();
  assert.equal(fx.popouts.length,1);assert.equal(fx.journals.length,1);assert.equal(fx.uploads.length,0);
 }finally{fx.restore();}
});
