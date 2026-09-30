const {chromium}=require('playwright');
const fs=require('node:fs');
const {spawn}=require('node:child_process');

const os=require('node:os');const path=require('node:path');const qaFolder=fs.mkdtempSync(path.join(os.tmpdir(),'aging-qa-'));
const root=path.resolve(__dirname,'../..');
const reference=process.argv[2];
if(!reference||!fs.existsSync(reference))throw new Error('Usage: npm run test:browser -- <absolute path to supplied reference PNG>');
const production=process.env.AGING_BROWSER_MODE==='production';
const python=path.join(root,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const servers=[spawn(python,['-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000'],{cwd:root+'/backend',env:{...process.env,EXCEL_FILE_PATH:path.join(qaFolder,'qa-data.xlsx'),CHECKPOINT_INTERVAL_SECONDS:'0'},stdio:'ignore'}),spawn(process.execPath,production?['scripts/serve.mjs']:['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{cwd:root+'/frontend',env:{...process.env,SERVER_HOST:'127.0.0.1'},stdio:'inherit'})];
process.on('exit',()=>servers.forEach(s=>s.kill()));
(async()=>{
 await new Promise(r=>setTimeout(r,1500));
 if(servers.some(server=>server.exitCode!==null))throw new Error('A test server could not start. Ensure ports 5173 and 8000 are free and HTTPS certificates exist.');
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || undefined});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}});
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const external=[];page.on('request',request=>{if(!request.url().startsWith('https://127.0.0.1:5173/'))external.push(new URL(request.url()).origin);});
 await page.goto('https://127.0.0.1:5173');
 await page.getByText('Server connected',{exact:true}).waitFor();
 console.log('HTTPS/frontend/proxy',await page.evaluate(()=>({secure:window.isSecureContext,cameraAPI:!!navigator.mediaDevices?.getUserMedia})));
 await page.setViewportSize({width:390,height:844});
 if(!await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth))throw new Error('Mobile overflow.');
 await page.getByRole('button',{name:'Open camera',exact:true}).click();
 await page.getByRole('alert').waitFor({timeout:20000});
 console.log('Camera without hardware',await page.getByRole('alert').textContent());
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:/02 Aging Test/}).click();
 await page.getByLabel('Registered serial number').fill('T130R4CIK54677');
 await page.getByRole('button',{name:'Find device',exact:true}).click();
 await page.getByRole('alert').waitFor();
 console.log('Missing record',await page.getByRole('alert').textContent());
 // Supply the user-provided reference ONLY to this test page, not to the application API.
 await page.route('**/test-reference.png',r=>r.fulfill({contentType:'image/png',body:fs.readFileSync(reference)}));
 if(!production){
 const result=await page.evaluate(async()=>{
   const {recognize,readRegion,newWorker,REGIONS}=await import('/src/ocr.ts');
   const img=new Image();img.src='/test-reference.png';await img.decode();
   const source=document.createElement('canvas');source.width=img.width;source.height=img.height;source.getContext('2d').drawImage(img,0,0);
   const worker=await newWorker(()=>{});const raw={};
   for(const [name,region] of Object.entries(REGIONS)){raw[name]=await readRegion(worker,source,region,false,name==='label'?'6':'7');}
   await worker.terminate();
   try{return {raw,reading:await recognize(source,'^T[0-9]{3}R[0-9][A-Z]{3}[0-9]{5}$',()=>{})};}catch(e){return {raw,error:e.message};}
 });
 if(result.reading?.serial_number!=='T130R4CIK54677'||result.reading?.battery_percent!==84||result.reading?.device_timestamp!=='12:44 PM')throw new Error('Reference OCR did not match expected screen.');
 console.log('OCR reference',JSON.stringify({reading:result.reading,error:result.error,raw:Object.fromEntries(Object.entries(result.raw).map(([key,v])=>[key,{text:v.text,confidence:v.confidence}]))}));if(errors.length)throw new Error(errors.join('; '));

 }

 await page.evaluate(()=>{
   const image=new Image();image.src='/test-reference.png';
   navigator.mediaDevices.getUserMedia=async()=>{
     await image.decode();
     const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=900;
     const ctx=canvas.getContext('2d');
     const paint=()=>{ctx.fillStyle='#111';ctx.fillRect(0,0,1600,900);ctx.drawImage(image,80,(900-1440*516/1536)/2,1440,1440*516/1536);};
     paint();const stream=canvas.captureStream(10);const timer=setInterval(paint,100);
     stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;
   };
 });
 await page.getByRole('button',{name:/01 Device Registration/}).click();
 await page.route('**/api/captures',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Workbook busy. Please retry.'})}));
 await page.getByRole('button',{name:'Open camera',exact:true}).click();
 await page.getByRole('button',{name:'Capture now',exact:true}).click();
 await page.getByText('Workbook busy. Please retry.',{exact:true}).waitFor();
 await page.getByText('Camera diagnostic',{exact:true}).click();
 await page.getByText(/capture-ticket \/ Error/).waitFor();
 await page.unroute('**/api/captures');
 await page.getByRole('button',{name:'Retry camera',exact:true}).click();
 await page.getByRole('button',{name:'Confirm & save reading',exact:true}).waitFor({timeout:90000});
 console.log('Capture-ticket failure shown accurately; clean retry PASS');
 await page.getByRole('heading',{name:'T130R4CIK54677',exact:true}).waitFor();
 if(!(await page.locator('.reading-grid').innerText()).includes('84%'))throw new Error('Wrong battery crop');
 console.log('QR serial, battery crop and automatic capture PASS');
 const posts=[];page.on('request',r=>{if(r.method()==='POST')posts.push({url:r.url(),body:r.postDataJSON()});});
 await page.getByRole('button',{name:'Confirm & save reading',exact:true}).click();
 await page.getByText('Reading saved successfully.',{exact:true}).waitFor();
 if(posts.length!==1 || Object.keys(posts[0].body).sort().join(',')!=='battery_percent,capture_token,device_timestamp,serial_number')throw new Error('Unexpected registration request fields.');
 console.log('Browser registration saved',posts.map(p=>({url:p.url,fields:Object.keys(p.body)})));
 await page.getByText('WAITING FOR 100 PERCENT CHARGE',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Open camera',exact:true}).click();
 await page.getByRole('button',{name:'Capture now',exact:true}).waitFor();
 await page.getByRole('button',{name:'Capture now',exact:true}).click();
 await page.getByRole('button',{name:'Confirm & save reading',exact:true}).waitFor({timeout:60000});
 console.log('Manual capture fallback PASS');
 await page.getByRole('button',{name:/03 Post-Aging Charge/}).click();
 console.log('Post-aging blocked in UI',await page.getByText('Complete all four aging checkpoints and restart confirmations first.').isVisible());

 if(production){
   for(const url of ['/src/App.tsx','/.env','/certs/lan-key.pem','/api/docs']){
     const response=await page.request.get('https://127.0.0.1:5173'+url);if(response.status()<400)throw new Error('Unexpected exposed resource: '+url);
   }
   const denied=await page.request.post('https://127.0.0.1:5173/api/captures',{headers:{Origin:'https://attacker.example'},data:{action:'register'}});
   if(denied.status()!==403)throw new Error('Cross-origin request accepted');
   const large=await page.request.post('https://127.0.0.1:5173/api/captures',{data:{action:'register',padding:'x'.repeat(5000)}});
   if(large.status()!==413)throw new Error('Oversized request accepted');
   const resp=await page.request.get('https://127.0.0.1:5173/');
   if(!resp.headers()['content-security-policy']?.includes("frame-ancestors 'none'"))throw new Error('CSP missing');
   console.log('Built server: source/key isolation, origin guard, size limit and CSP PASS');
 }
 await page.getByRole('button',{name:/01 Device Registration/}).click();
 for(const name of ['NotAllowedError','NotReadableError','SecurityError','AbortError']){
   await page.evaluate(name=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('',name);};},name);
   await page.getByRole('button',{name:'Open camera',exact:true}).click();
   await page.getByRole('alert').waitFor();
   if((await page.locator('.scan-status').textContent()).includes('Opening'))throw new Error('Stuck startup status');
   await page.getByText('Camera diagnostic',{exact:true}).click();
   await page.getByText(new RegExp('camera / '+name)).waitFor();
   await page.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 console.log('Browser permission/security/abort diagnostics PASS');
 if(errors.length)throw new Error(errors.join('; '));
 if(external.length)throw new Error('Unexpected external network request');
 console.log('No external image/OCR requests PASS');
 if(process.env.QA_SCREENSHOT)await page.screenshot({path:process.env.QA_SCREENSHOT,fullPage:true});
 await browser.close();servers.forEach(s=>s.kill());
})().catch(e=>{console.error(e);process.exit(1)});
