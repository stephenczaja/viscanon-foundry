import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
const origin='http://foundry.invalid';
const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/bridge.css"><style>
*{box-sizing:border-box}body{margin:0;background:#393e47;font-family:Arial,sans-serif}.application{position:absolute;left:40px;top:40px;display:flex;flex-direction:column;width:1120px;height:630px;overflow:hidden}.window-header{height:32px;flex:0 0 32px;background:#292724;color:#eee}.window-content{flex:1;display:flex;background:#e8d5b4}.window-content>div{width:100%}button,input,select{font-family:inherit}
</style></head><body><div class="application viscanon-bridge-workspace"><header class="window-header">Viscanon</header><main class="window-content"></main></div><script type="module">
import {createWorkspaceApplication} from '/scripts/workspace-ui.mjs';
window.game={scenes:{contents:[],current:null},actors:{contents:[{id:'z',name:'Zephyr'},{id:'a',name:'Alpha'}]}};
window.ui={notifications:{info(){},error(){}}};
window.foundry={applications:{api:{ApplicationV2:class{_onRender(){} _onClose(){} async minimize(){} async maximize(){} async close(){}}}}};
const command={id:'30000000-0000-4000-8000-000000000001',campaignId:'10000000-0000-4000-8000-000000000001',expiresAt:Date.now()+90000,entry:{id:'20000000-0000-4000-8000-000000000001',type:'scene',title:'Synthetic artwork',chapter:'Synthetic chapter',category:'scene',image:'/fixture.svg',artworkFingerprint:'a'.repeat(64),battlemapFingerprint:null}};
window.mutations=[];window.allowed=true;window.hold=false;
const actions={actorTypes:()=>['npc','character'],prefetchArtwork:async()=>{},assertFresh(){},attachActor:async(value,id,type)=>{mutations.push({id,type});return{name:'Synthetic actor'};},releaseArtwork(){}};
const Popup=createWorkspaceApplication(command,actions,()=>{},()=>allowed,async()=>{if(hold)await new Promise(resolve=>window.release=resolve);return command;});
window.popup=new Popup();popup.element=document.querySelector('.application');
document.querySelector('main').append(await popup._renderHTML());popup._onRender({},{});window.ready=true;
</script></body></html>`;

for(const [name,width,height] of [['default',1120,630],['large',1400,950],['narrow',460,760]]) {
  test(`native popup actor keyboard controls and layout: ${name}`,async()=>{
    const browser=await chromium.launch({headless:true,timeout:3000,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const unexpected=[],errors=[];
    try {
      const page=await browser.newPage({viewport:{width:width+80,height:height+80},serviceWorkers:'block'});
      page.setDefaultTimeout(3000);
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin){unexpected.push(route.request().url());await route.abort('blockedbyclient');return;}
        if(url.pathname==='/'){await route.fulfill({contentType:'text/html',body:html});return;}
        if(url.pathname==='/fixture.svg'){await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="600" height="840" fill="#172e3d"/></svg>'});return;}
        const relative=url.pathname.replace(/^\/modules\/viscanon-bridge\//,'/').slice(1);
        const path=resolve(root,relative);
        if(!/^(scripts\/.*\.mjs|styles\/bridge\.css|assets\/[^?]+\.svg)$/.test(relative)||!path.startsWith(root)){
          unexpected.push(route.request().url());await route.abort('blockedbyclient');return;
        }
        await route.fulfill({contentType:({'.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(path)],body:readFileSync(path)});
      });
      await page.goto(origin+'/');await page.waitForFunction(()=>window.ready);
      await page.locator('.application').evaluate((el,{width,height})=>{el.style.width=width+'px';el.style.height=height+'px';},{width,height});
      const metrics=await page.evaluate(()=>{
        const body=document.querySelector('.viscanon-bridge-workspace-body');
        const icon=document.querySelector('.viscanon-bridge-workspace-visibility-icon').getBoundingClientRect();
        const select=document.querySelector('[data-workspace-field=visibility]').getBoundingClientRect();
        const label=document.querySelector('[data-workspace-field=visibility]').closest('label').getBoundingClientRect();
        const rects=[...document.querySelectorAll('.viscanon-bridge-workspace-section')].map(el=>el.getBoundingClientRect());
        return{horizontalOverflow:body.scrollWidth>body.clientWidth,icon:{left:icon.left,right:icon.right,top:icon.top,bottom:icon.bottom,width:icon.width,height:icon.height},select:{left:select.left,top:select.top,bottom:select.bottom},label:{left:label.left,top:label.top},cardHeights:rects.map(r=>r.height)};
      });
      assert.equal(metrics.horizontalOverflow,false);
      assert.equal(metrics.icon.width,56);assert.equal(metrics.icon.height,42);
      assert.ok(metrics.icon.right<=metrics.label.left,'icon is beside the label/dropdown without overlap');
      assert.ok(metrics.label.top<metrics.select.top,'label remains above its own dropdown');
      assert.ok(Math.abs(metrics.icon.bottom-metrics.select.bottom)<1,'icon aligns with the dropdown bottom as on unchanged main');
      if(name!=='narrow')assert.ok(Math.max(...metrics.cardHeights)-Math.min(...metrics.cardHeights)<1,'desktop action cards retain equal heights');
      const create=page.locator('[data-workspace-field=actor-mode-create]'),select=page.locator('[data-workspace-field=actor-mode-select]');
      const actor=page.locator('[data-workspace-field=actor]'),type=page.locator('[data-workspace-field=actor-type]'),attach=page.locator('[data-workspace-action=actor]');
      assert.equal(await actor.isVisible(),false);assert.equal(await type.isVisible(),true);
      await create.focus();await page.keyboard.press('Tab');
      assert.equal(await select.evaluate(el=>el===document.activeElement),true,'Tab reaches Select without pointer activation');
      await page.keyboard.press('Enter');
      assert.equal(await actor.isVisible(),true);assert.equal(await type.isVisible(),false);
      assert.equal(await attach.isDisabled(),true);
      assert.deepEqual(await actor.locator('option').allTextContents(),['Choose an actor','Alpha','Zephyr']);
      await actor.selectOption('z');await select.focus();await page.keyboard.press('Shift+Tab');
      assert.equal(await create.evaluate(el=>el===document.activeElement),true);
      await page.keyboard.press('Space');
      assert.equal(await actor.isVisible(),false);assert.equal(await type.isVisible(),true);
      await select.focus();await page.keyboard.press('Space');
      await page.evaluate(()=>{window.hold=true;});
      await attach.focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>typeof window.release==='function');
      assert.equal(await create.isDisabled(),true);assert.equal(await select.isDisabled(),true);
      assert.equal(await actor.isDisabled(),true);assert.equal(await type.isDisabled(),true);
      await page.evaluate(()=>{document.querySelector('[data-workspace-field=actor]').value='a';window.release();});
      await page.waitForFunction(()=>window.mutations.length===1);
      assert.deepEqual(await page.evaluate(()=>window.mutations),[{id:'z',type:'npc'}]);
      await page.evaluate(()=>{window.game.actors.contents=[];});await select.press('Enter');
      assert.deepEqual(await actor.locator('option').allTextContents(),['No actors available']);
      assert.equal(await attach.isDisabled(),true);
      assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
      if(process.env.VISCANON_UI_EVIDENCE_DIR){
        mkdirSync(process.env.VISCANON_UI_EVIDENCE_DIR,{recursive:true});
        writeFileSync(resolve(process.env.VISCANON_UI_EVIDENCE_DIR,name+'.json'),JSON.stringify({name,width,height,metrics,keyboard:true,stableTarget:true,errors,unexpected},null,2));
        await page.locator('.application').screenshot({path:resolve(process.env.VISCANON_UI_EVIDENCE_DIR,name+'.png')});
      }
    }finally{await browser.close();}
  });
}
