import test from 'node:test';
import assert from 'node:assert/strict';
import { numberedNameFlag, installPlayerDocumentNames } from '../scripts/workspace-names.mjs';
const ID = 'viscanon-bridge';

// Model the documented source/derived-data boundary, not a real Foundry world.
class Document {
  constructor(data, parent) { this._source = structuredClone(data); this.parent = parent; this.prepareData(); }
  prepareData() { Object.assign(this, structuredClone(this._source)); this.prepareDerivedData(); }
  prepareDerivedData() { this.basePrepared = true; }
  automaticLink() { return this.name; }
  sheetTitle() { return this.name; }
}
function fixture(user) {
  const world = {user}, config = Object.fromEntries(['Scene','JournalEntry','JournalEntryPage'].map(type => [type,{documentClass:Document}]));
  installPlayerDocumentNames(config, world);
  return {world,config};
}
const flags = {[ID]:numberedNameFlag({type:'scene',sceneNumber:'A1'})};

for (const isGM of [true,false]) test(`numbered Scene, pin journal and page names are prepared for ${isGM?'GM':'player'} surfaces`,()=>{
  const {config}=fixture({isGM});
  const data={name:'A1: Arrival',navName:'Arrival',flags,ownership:{default:0}};
  const scene=new config.Scene.documentClass(data);
  const journal=new config.JournalEntry.documentClass({...data,navName:undefined});
  const page=new config.JournalEntryPage.documentClass({name:data.name,ownership:{default:0}},journal);
  for(const doc of [scene,journal,page]) {
    assert.equal(doc.basePrepared,true);
    for(const label of [doc.name,doc.automaticLink(),doc.sheetTitle()]) assert.equal(label,isGM?'A1: Arrival':'Arrival');
    assert.equal(doc._source.name,'A1: Arrival');
    assert.deepEqual(doc.ownership,{default:0});
  }
  assert.equal(scene.navName,'Arrival');
});

test('custom player navigation names survive repeated preparation, role changes, and source updates',()=>{
  const {config,world}=fixture({isGM:false});
  const scene=new config.Scene.documentClass({name:'A1: Arrival',navName:'The Harbor',flags});
  assert.equal(scene.name,'The Harbor');scene.prepareData();assert.equal(scene.name,'The Harbor');
  world.user={isGM:true};scene.prepareData();assert.equal(scene.name,'A1: Arrival');
  world.user={isGM:false};scene._source.navName='A custom name';scene.prepareData();assert.equal(scene.name,'A custom name');
  assert.equal(scene._source.name,'A1: Arrival');
});

test('blank navigation names use only the recorded prefix; user renames and unmarked old documents are preserved',()=>{
  const {config}=fixture({isGM:false});
  for(const [name,marker,expected] of [
    ['A1: Arrival',flags,'Arrival'],['1984',flags,'1984'],['12: Custom title',flags,'12: Custom title'],
    ['A1: Arrival',{},'A1: Arrival'],['A1: Arrival',{[ID]:{numberedName:{version:2,prefix:'A1: '}}},'A1: Arrival']
  ]) assert.equal(new config.Scene.documentClass({name,navName:'',flags:marker}).name,expected);
  assert.deepEqual(numberedNameFlag({type:'location',sceneNumber:'9'}),{});
  assert.deepEqual(numberedNameFlag({type:'scene',sceneNumber:''}),{});
});

test('installation extends configured document classes once and makes no document writes',()=>{
  const {config,world}=fixture({isGM:false});
  const Scene=config.Scene.documentClass;installPlayerDocumentNames(config,world);
  assert.equal(config.Scene.documentClass,Scene);
  assert.ok(new Scene({name:'A1: Arrival',flags}) instanceof Document);
  installPlayerDocumentNames(undefined,world);
});
