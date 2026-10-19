import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ENDPOINT } from '../scripts/bridge-core.mjs';
import { createWorkspaceActions, PIN_ICON, PIN_ICONS } from '../scripts/workspace-actions.mjs';

const campaignId = '10000000-0000-4000-8000-000000000001';
const entryId = '20000000-0000-4000-8000-000000000001';
const fingerprint = 'c'.repeat(64);
const image = `${new URL(DEFAULT_ENDPOINT).origin}/storage/v1/object/sign/artwork/image.webp?token=synthetic`;
const path = 'persistent/synthetic-public-art.png';
const command = {id: '30000000-0000-4000-8000-000000000001', campaignId,
  entry: {id: entryId, image, battlemap: '', artworkFingerprint: fingerprint, title: 'PRIVATE TITLE'}};
const imageResponse = () => ({ok: true, headers: {get: () => 'image/png'},
  blob: async () => new Blob([Uint8Array.of(1, 2, 3, 4)], {type: 'image/png'})});

function pinFixture(apps = {}, verifyPinVisibility = async () => true,
  uploadImpl = async () => ({path}), fetchImpl = async () => imageResponse(),
  checkAction = async current => current, revealViscanon, shareReveal) {
  const events = [], uploads = [];
  const flags = {campaignId, entryId, artworkFingerprint: fingerprint,
    visibility: 'on_reveal', localRevealed: false, publicArtworkPath: ''};
  const page = {name: 'Viscanon artwork', type: 'image', src: PIN_ICON, ownership: {default: 0},
    async update(changes) {
      events.push(`page:${Object.keys(changes)[0]}`);
      Object.assign(this, changes);
    }};
  const journal = {id: 'journal-synthetic', name: 'Viscanon artwork',
    flags: {'viscanon-bridge': flags}, ownership: {default: 0}, pages: {contents: [page]},
    async update(changes) {
      events.push(`journal:${Object.keys(changes)[0]}`);
      for (const [key, value] of Object.entries(changes)) {
        if (key.startsWith('flags.viscanon-bridge.')) flags[key.slice('flags.viscanon-bridge.'.length)] = value;
        else Object.assign(this, {[key]: value});
      }
    }};
  const world = {user: {id: 'gm', isGM: true},
    users: {activeGM: {id: 'gm'}, contents: [{id: 'gm', isGM: true}, {id: 'player', isGM: false}]},
    journal: {contents: [journal]}};
  const actions = createWorkspaceActions({game: world, foundry: {applications: {apps}},
    verifyPinVisibility, checkAction, revealViscanon, shareReveal,
    filePicker: {uploadPersistent: async (_module, _folder, file) => {
      uploads.push(file); events.push('upload'); return uploadImpl();
    }}, imageBitmap: async () => ({width: 300, height: 300, close() {}}),
    fetchImpl});
  const pair = {entryId, fingerprint, needsArtwork: true};
  return {actions, world, journal, page, pair, events, uploads};
}

test('on-reveal canvas icons follow reveal and Undo across scenes while explicit modes stay fixed', async () => {
  const {actions, world, journal, pair, events} = pinFixture();
  const iconUpdates = [];
  const note = (entryId, icon, marked = true) => ({entryId, texture:{src:icon},
    flags: {'viscanon-bridge':{mapPin:marked}},
    async update(changes) {
      events.push('note:texture'); iconUpdates.push(changes);
      this.texture.src = changes['texture.src'];
    }});
  const first = note(journal.id, PIN_ICONS.on_reveal);
  const second = note(journal.id, PIN_ICONS.on_reveal);
  const ordinary = note(journal.id, 'custom.svg', false);
  const explicit = ['gm_only','visible'].map(mode => {
    const item = {...journal, id:`journal-${mode}`, ownership:{default:mode==='visible'?2:0},
      flags:{'viscanon-bridge':{...journal.flags['viscanon-bridge'],visibility:mode}}};
    world.journal.contents.push(item);
    return {journal:item,note:note(item.id,PIN_ICONS[mode])};
  });
  world.scenes={contents:[{notes:{contents:[first,ordinary,...explicit.map(item=>item.note)]}},
    {notes:{contents:[second]}}]};
  try {
    await actions.reconcilePins({campaignId,requested:[pair],visiblePins:[pair],
      visiblePinArtwork:[{entryId,fingerprint,image}]});
    assert.equal(first.texture.src,PIN_ICONS.visible);
    assert.equal(second.texture.src,PIN_ICONS.visible);
    assert.equal(journal.ownership.default,2);
    const beforeUndo=events.length;
    await actions.reconcilePins({campaignId,requested:[pair],visiblePins:[]});
    assert.equal(first.texture.src,PIN_ICONS.on_reveal);
    assert.equal(second.texture.src,PIN_ICONS.on_reveal);
    assert.equal(journal.ownership.default,0);
    assert.ok(events.indexOf('journal:ownership',beforeUndo)<events.indexOf('note:texture',beforeUndo),
      'Undo revokes permissions before changing the icon');
    await actions.reconcilePins({campaignId,requested:[pair],visiblePins:[]});
    assert.equal(iconUpdates.length,4,'unchanged icons do not cause repeated world updates');
    assert.equal(ordinary.texture.src,'custom.svg');
    for(const {journal:item,note:pin}of explicit){
      const mode=item.flags['viscanon-bridge'].visibility;
      assert.equal(pin.texture.src,PIN_ICONS[mode]);
      assert.equal(item.ownership.default,mode==='visible'?2:0);
    }
  } finally {actions.destroy();}
});

