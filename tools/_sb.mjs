import puppeteer from 'puppeteer-core'
import { dismissWelcome } from './lib/welcome.mjs'
const b = await puppeteer.launch({executablePath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']})
const p = await b.newPage()
await p.setViewport({width:2552,height:1208,deviceScaleFactor:1})
await p.goto('http://localhost:5177/',{waitUntil:'networkidle2'})
await new Promise(r=>setTimeout(r,2500))
await dismissWelcome(p)
await new Promise(r=>setTimeout(r,1200))
console.log(await p.evaluate(()=>{
  const ui = window.__esque?.useUI?.getState?.()
  const aside=[...document.querySelectorAll('aside,[data-panel]')].map(e=>{const r=e.getBoundingClientRect();return `${e.tagName}.${String(e.className).slice(0,40)} ${Math.round(r.width)}x${Math.round(r.height)}`})
  return JSON.stringify({compact:ui?.compact,leftPanelOpen:ui?.leftPanelOpen,leftPanelWidth:ui?.leftPanelWidth,overlayPanel:ui?.overlayPanel,module:ui?.module,asides:aside},null,1)
}))
await p.screenshot({path:'/tmp/sb.png'})
await b.close()
