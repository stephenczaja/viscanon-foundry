import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinPlacement } from '../scripts/workspace-pin.mjs';

function fixture({resolution=1,zoom=1,pan={x:120,y:80}}={}) {
  const listeners=new Map(),keys=new Map(),warnings=[],previews=[];
  const rect={left:60,top:30,width:800,height:640};
  const screen={width:1000,height:800};
  const scene={id:'current-scene',width:800,height:600};
  const view={style:{cursor:'default'},getBoundingClientRect:()=>rect,
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const document={body:{append:el=>previews.push(el)},
    createElement:()=>({style:{},remove(){this.removed=true;}}),
    addEventListener:(name,fn)=>keys.set(name,fn),removeEventListener:name=>keys.delete(name)};
  let conversions=0,authorized=true;
  const board={scene,ready:true,dimensions:{sceneRect:{x:100,y:50,width:800,height:600}},
    app:{view,renderer:{screen,resolution,width:screen.width*resolution,height:screen.height*resolution}},
    stage:{toLocal:p=>({x:(p.x-pan.x)/zoom,y:(p.y-pan.y)/zoom})},
    // Model Foundry's documented client-to-canvas contract, not the module's
    // old backing-pixel arithmetic. Device resolution does not change a scene point.
    canvasCoordinatesFromClient(p){
      conversions++;
      return this.stage.toLocal({x:(p.x-rect.left)*screen.width/rect.width,
        y:(p.y-rect.top)*screen.height/rect.height});
    }};
  const savedUI=globalThis.ui;
  globalThis.ui={notifications:{warn:message=>warnings.push(message)}};
  const placement=createPinPlacement({board,document,icon:'synthetic.svg',
    assertGM(){if(!authorized)throw Error('GM no longer authorized.');}});
  return {board,scene,warnings,previews,listeners,keys,...placement,
    get conversions(){return conversions;},deny(){authorized=false;},
    clickWorld(p){
      const global={x:p.x*zoom+pan.x,y:p.y*zoom+pan.y};
      assert(global.x>=0&&global.x<=screen.width&&global.y>=0&&global.y<=screen.height,
        'Synthetic target must be visible in the renderer viewport');
      const event={button:0,clientX:rect.left+global.x*rect.width/screen.width,
        clientY:rect.top+global.y*rect.height/screen.height,preventDefault(){},stopImmediatePropagation(){}};
      listeners.get('pointerdown')?.(event);
    },restore(){placement.cancelPinPlacement();globalThis.ui=savedUI;}};
}

for(const scenario of [
  {name:'DPR1 padded scene and CSS-scaled view',resolution:1,point:{x:660,y:470}},
  {name:'DPR2 visible interior point',resolution:2,point:{x:660,y:470}},
  {name:'DPR2 zoomed-out and panned scene',resolution:2,zoom:.5,pan:{x:-40,y:-20},point:{x:660,y:470}},
  {name:'DPR2 zoomed-in visible point',resolution:2,zoom:2,point:{x:350,y:230}},
  {name:'DPR3 zoomed-in visible point',resolution:3,zoom:2,point:{x:350,y:230}}
])test('pin coordinate conversion: '+scenario.name,async()=>{
  const fx=fixture(scenario);
  try {
    const pending=fx.captureMapPoint(fx.scene);
    fx.clickWorld(scenario.point);
    // Cancel a rejected baseline click so the failure is bounded and leaves
    // no hanging placement promise. A successful capture is already settled.
    fx.cancelPinPlacement();
    const point=await pending;
    assert.deepEqual(point,scenario.point,JSON.stringify({warnings:fx.warnings}));
    assert.deepEqual(fx.warnings,[]);
    assert.equal(fx.listeners.size+fx.keys.size,0);
  }finally{fx.restore();}
});

test('native conversion retains padded-scene bounds and permits a corrected user click',async()=>{
  const fx=fixture({resolution:2});
  try {
    const pending=fx.captureMapPoint(fx.scene);
    fx.clickWorld({x:50,y:20}); // Visible padding, outside the actual scene.
    assert.deepEqual(fx.warnings,['Choose a point inside the scene.']);
    assert.equal(fx.previews[0].removed,undefined);
    fx.clickWorld({x:660,y:470});fx.cancelPinPlacement();
    assert.deepEqual(await pending,{x:660,y:470});
    assert.equal(fx.previews[0].removed,true);
  }finally{fx.restore();}
});

test('non-finite native output cannot bypass bounds or create a placement',async()=>{
  const fx=fixture();
  try {
    fx.board.stage.toLocal=()=>({x:NaN,y:Infinity});
    fx.board.canvasCoordinatesFromClient=()=>({x:NaN,y:Infinity});
    const pending=fx.captureMapPoint(fx.scene);
    fx.clickWorld({x:660,y:470});fx.cancelPinPlacement();
    assert.equal(await pending,null);
    assert.deepEqual(fx.warnings,['Choose a point inside the scene.']);
  }finally{fx.restore();}
});

test('coordinate conversion does not bypass current GM authorization',async()=>{
  const fx=fixture();
  try {
    const pending=fx.captureMapPoint(fx.scene);pending.catch(()=>{});
    fx.deny();fx.clickWorld({x:660,y:470});
    await assert.rejects(pending,/GM no longer authorized/);
    assert.equal(fx.conversions,0);assert.equal(fx.listeners.size,0);
  }finally{fx.restore();}
});
