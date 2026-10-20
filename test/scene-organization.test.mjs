import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneFolderPlan, validateSceneOrganization } from '../scripts/workspace-scene-folders.mjs';
import { validateWorkspaceCommand } from '../scripts/workspace-core.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const path = names => names.map((name, index) => ({id: id(index + 10), name}));
const organization = names => ({version: 1, status: 'resolved', reason: '', locations: path(names)});
const command = (type, names) => ({campaignId: id(1), entry: {type, chapterId: id(2), chapter: 'Chapter 1', sceneOrganization: organization(names)}});

test('location artwork, scenes and characters share canonical location folders; categories are lazy', async () => {
  const location = await sceneFolderPlan(command('location', ['Saltmarsh Environs']));
  const scene = await sceneFolderPlan(command('scene', ['Saltmarsh Environs']));
  const character = await sceneFolderPlan(command('character', ['Saltmarsh Environs']));
  assert.deepEqual(location.steps.map(row => row.name), ['Chapter 1', 'Saltmarsh Environs']);
  assert.deepEqual(scene.steps.map(row => row.name), ['Chapter 1', 'Saltmarsh Environs', 'Scenes']);
  assert.deepEqual(character.steps.map(row => row.name), ['Chapter 1', 'Saltmarsh Environs', 'Characters']);
  assert.equal(scene.steps[1].key, location.steps[1].key);
  assert.equal(character.steps[1].key, location.steps[1].key);
  assert.equal(scene.notice, '');
});

test('twelve canonical ancestors use one full label and leave category room at native depth four', async () => {
  for (const names of [Array.from({length:12}, (_,index) => `Location ${index + 1}`), Array(12).fill('Cell')]) {
    for (const type of ['location', 'scene', 'character']) {
      const plan = await sceneFolderPlan(command(type, names), 4);
      assert.deepEqual(plan.steps.map(row => row.name), ['Chapter 1', names.join(' — '),
        ...(type === 'location' ? [] : [type === 'scene' ? 'Scenes' : 'Characters'])]);
      assert.ok(plan.steps.length + 1 <= 4);
      assert.equal(plan.notice, '');
    }
  }
  const c = command('scene', ['Saltmarsh Environs', 'Barracks', 'Basement', 'Cell']);
  const expected = ['Chapter 1', 'Saltmarsh Environs — Barracks — Basement — Cell', 'Scenes'];
  assert.deepEqual((await sceneFolderPlan(c, 4)).steps.map(row => row.name), expected);
  assert.deepEqual((await sceneFolderPlan(c, 6)).steps.map(row => row.name), expected, 'a larger native limit never restores recursion');
  await assert.rejects(sceneFolderPlan(c, 3), /folder depth limit/, 'an inadequate native limit never silently removes the category');
});

test('stable opaque identities distinguish same-title locations and chapter contexts', async () => {
  const a = command('scene', ['City']);
  const b = structuredClone(a); b.entry.sceneOrganization.locations[0].id = id(99);
  const renamed = structuredClone(a); renamed.entry.sceneOrganization.locations[0].name = 'New city';
  const otherChapter = structuredClone(a); otherChapter.entry.chapterId = id(98);
  const [pa, pb, pr, pc] = await Promise.all([a,b,renamed,otherChapter].map(c => sceneFolderPlan(c)));
  assert.notEqual(pa.steps[1].key, pb.steps[1].key);
  assert.equal(pa.steps[1].key, pr.steps[1].key);
  assert.notEqual(pa.steps[1].key, pc.steps[1].key);
  const otherCampaign = structuredClone(a); otherCampaign.campaignId = id(97);
  assert.notEqual(pa.steps[1].key, (await sceneFolderPlan(otherCampaign)).steps[1].key);
  const nestedA = command('scene', ['North', 'Cell']);
  const nestedB = command('scene', ['South', 'Cell']);
  nestedB.entry.sceneOrganization.locations[0].id = id(96);
  const [north, south] = await Promise.all([nestedA,nestedB].map(c => sceneFolderPlan(c)));
  assert.equal(north.steps[1].name, 'North — Cell'); assert.equal(south.steps[1].name, 'South — Cell');
  assert.notEqual(north.steps[1].key, south.steps[1].key, 'every ancestor UUID participates in identity');
  assert.ok(pa.steps.every(row => /^[a-f0-9]{64}$/.test(row.key)));
  assert.doesNotMatch(JSON.stringify(pa.steps.map(row => row.key)), /10000000|Chapter|City/);
});

test('missing chapter stays at root; unresolved links explicitly fall back without a guessed location', async () => {
  const c = command('character', ['Coast']); c.entry.chapter = ''; c.entry.chapterId = null;
  assert.deepEqual((await sceneFolderPlan(c)).steps.map(row => row.name), ['Coast', 'Characters']);
  for (const status of ['none', 'unresolved']) {
    c.entry.sceneOrganization = {version:1,status,reason:status==='none'?'':'ambiguous',locations:[]};
    const plan = await sceneFolderPlan(c);
    assert.deepEqual(plan.steps.map(row => row.name), ['Characters']);
    assert.equal(Boolean(plan.notice), status === 'unresolved');
  }
});

test('unassigned entry kinds retain their chapter category without invented locations', async () => {
  for (const [type, category] of [['scene','Scenes'],['character','Characters'],['location','Locations']]) {
    const c = command(type, []);
    for (const status of ['none','unresolved']) {
      c.entry.sceneOrganization = {version:1,status,reason:status === 'none' ? '' : 'missing',locations:[]};
      const plan = await sceneFolderPlan(c,4);
      assert.deepEqual(plan.steps.map(row => row.name), ['Chapter 1',category]);
      assert.equal(Boolean(plan.notice), status === 'unresolved');
    }
  }
});

test('malformed, cyclic, overlong and unsupported organization projections fail closed', async () => {
  for (const change of [{version:2},{status:'guessed'},{reason:'SECRET'}, {locations:[]},
    {locations:[{id:'bad',name:'City'}]}, {locations:[{id:id(10),name:''}]},
    {locations:[{id:id(10),name:'A'},{id:id(10),name:'B'}]},
    {locations:Array.from({length:13},(_,i)=>({id:id(i+10),name:'X'}))}]) {
    assert.equal(validateSceneOrganization({...organization(['City']),...change}), null);
  }
  await assert.rejects(sceneFolderPlan({...command('scene',['City']),campaignId:'bad'}), /Invalid Scene/);
  const wire = {id:id(3),action:'open',campaignId:id(1),expiresAt:new Date(Date.now()+60000).toISOString(),entry:{id:id(10),
    type:'location',category:'location',title:'City',revealed:false,artworkFingerprint:'a'.repeat(64),
    image:'https://xzievefbzeyvefazppvj.supabase.co/storage/v1/object/sign/artwork/synthetic.png?token=fake'}};
  assert.ok(validateWorkspaceCommand(wire), 'older backend remains compatible');
  assert.ok(validateWorkspaceCommand({...wire,entry:{...wire.entry,sceneOrganization:organization(['City'])}}));
  assert.equal(validateWorkspaceCommand({...wire,entry:{...wire.entry,sceneOrganization:{...organization(['City']),locations:[{id:id(11),name:'Wrong location'}]}}}), null);
});
