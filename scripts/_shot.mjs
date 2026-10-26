import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
const PORT = 9381
const profile = mkdtempSync(join(tmpdir(),'wb-shot-'))
const sleep = ms => new Promise(r=>setTimeout(r,ms))
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--window-size=1400,2400','--force-device-scale-factor=1.5',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'})
let wsUrl=null
for(let i=0;i<60&&!wsUrl;i++){await sleep(200);try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok)wsUrl=(await r.json()).webSocketDebuggerUrl}catch{}}
const tab=await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'})
const ws=new WebSocket((await tab.json()).webSocketDebuggerUrl)
await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true})})
let idc=0;const pending=new Map()
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}})
const send=(method,params={})=>new Promise(res=>{const id=++idc;pending.set(id,res);ws.send(JSON.stringify({id,method,params}))})
const ev=async body=>{const r=await send('Runtime.evaluate',{expression:`JSON.stringify((()=>{try{${body}}catch(e){return{__err:String((e&&e.stack)||e)}}})())`,returnByValue:true});const v=r.result.result.value;return typeof v==='string'?JSON.parse(v):{__raw:JSON.stringify(r.result)}}
await send('Runtime.enable');await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride',{width:1400,height:2400,deviceScaleFactor:1.5,mobile:false})
await send('Page.navigate',{url:pathToFileURL(resolve('dist-single/index.html')).href})
await sleep(9000)
await ev(`const items=[...document.querySelectorAll('a,button,nav *')];const t=items.find(e=>(e.textContent||'').trim().startsWith('模型'));if(t)t.click();return 1`)
await sleep(3000)
await ev(`const span=[...document.querySelectorAll('span')].find(s=>(s.textContent||'').trim()==='查看 ›');if(span){let n=span;for(let i=0;i<4&&n;i++){n.click();n=n.parentElement}}return 1`)
await sleep(4000)
// 滚到票型评估区
const box = await ev(`
  const cards=[...document.querySelectorAll('.card')];
  const c=cards.find(x=>(x.textContent||'').includes('算法评估了'));
  if(!c)return {found:false};
  c.scrollIntoView({block:'start'});
  const r=c.getBoundingClientRect();
  return {found:true, top:r.top+window.scrollY, h:r.height};
`)
console.log('票型区位置:', JSON.stringify(box))
if(box.found){
  const shot = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:260,y:box.top-16,width:1120,height:Math.min(box.h+40,1400),scale:1.5}})
  writeFileSync('shot-plans.png', Buffer.from(shot.result.data,'base64'))
  console.log('saved shot-plans.png')
}
ws.close();chrome.kill();rmSync(profile,{recursive:true,force:true})
process.exit(0)
