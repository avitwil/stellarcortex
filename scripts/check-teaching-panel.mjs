// Isolated UI fixture only: no live app, guest, credentials or provider requests.
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const module = fs.readFileSync(new URL('../public/desktop-teaching-panel.js', import.meta.url));
const html = `<button id="desktop">Desktop target</button><div id="panel"></div><script type="module">
import {mountDesktopTeaching} from '/panel.js';window.calls=[];window.clicks=0;window.reviewSteps=[{action:'scroll',amount:120},{action:'manual-input'}];document.querySelector('#desktop').onclick=()=>window.clicks++;
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6x8AAAAASUVORK5CYII=';
mountDesktopTeaching({element:document.querySelector('#panel'),botId:'fixture',view:{lease:{connectionId:'fixture'},onState:()=>{}},api:async(path,input)=>{window.calls.push(input);if(input.action==='review-text'){if(input.text!==null&&!input.confirmed)throw Error('Confirm storage and model disclosure');window.reviewSteps[input.index]=input.text===null?{action:'manual-input'}:{action:'reviewed-text',text:input.text,reviewed:true};return {steps:window.reviewSteps,instructions:JSON.stringify(window.reviewSteps)};}return ({start:{id:'draft'},capture:{frameId:'f',image:pixel,mimeType:'image/png',width:1,height:1},preview:{previewId:'p',image:pixel,mimeType:'image/png'},stop:{instructions:'Intended result: scroll and return\\n1. Scroll: 120',steps:window.reviewSteps},status:{state:'recording',count:1},review:{reviewed:true},save:{id:'skill'}})[input.action]||{};}});
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/panel.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/panel.js' ? module : html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText('Teach from screen', { exact: true }).click();
    assert.equal(await page.locator('dialog').evaluate(d => d.matches(':modal')), false);
    await page.locator('[name=objective]').fill('Scroll and return');
    await page.locator('[data-capture]').click();
    await page.locator('[name=safe]').check();
    await page.locator('[data-preview]').click();
    await page.locator('[data-stop]').click();
    await page.locator('[data-text-steps] textarea').fill('Hello שלום');
    await page.getByText('Use this text for the step', { exact: true }).click();
    assert.equal(await page.evaluate(() => window.reviewSteps[1].action), 'manual-input');
    await page.locator('[data-text-steps] input[type=checkbox]').check();
    await page.getByText('Use this text for the step', { exact: true }).click();
    await page.waitForFunction(() => window.reviewSteps[1].action === 'reviewed-text');
    assert.equal(await page.evaluate(() => window.reviewSteps[1].text), 'Hello שלום');
    await page.locator('[name=name]').fill('Fixture');
    await page.locator('[name=reviewed]').check();
    await page.getByText('Collapse / expand teaching', { exact: true }).click();
    await page.locator('#desktop').click();
    assert.equal(await page.evaluate(() => window.clicks), 1);
    await page.getByText('Collapse / expand teaching', { exact: true }).click();
    await page.getByText('Save skill for this bot', { exact: true }).click();
    await page.waitForFunction(() => window.calls.some(c => c.action === 'save'));
    const calls = await page.evaluate(() => window.calls);
    assert(calls.find(c => c.action === 'save').instructions.includes('reviewed action outline'));
    await page.locator('[data-close]').click();
    await page.close();
    console.log(`Teaching panel passed ${viewport.width}x${viewport.height}`);
  }
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
