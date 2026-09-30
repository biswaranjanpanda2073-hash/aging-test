// LAN server exposes only built assets and a bounded, fixed-target API proxy.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {root,hosts,origins,certificate,securityHeaders} from './runtime.mjs';
const dist=path.join(root,'dist');
if(!fs.existsSync(path.join(dist,'index.html')))throw new Error('Build missing. Run npm run ocr-assets and npm run build.');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json','.wasm':'application/wasm','.gz':'application/gzip'};
const server=https.createServer(certificate(),async(req,res)=>{
  for(const [key,value] of Object.entries(securityHeaders))res.setHeader(key,value);
  const fail=(status,message)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({detail:message}));}};
  try {
    if(!hosts.some(host=>req.headers.host===`${host}:5173`)){req.resume();return fail(400,'Unrecognized server address.');}
    if(req.headers.origin&&!origins.includes(req.headers.origin)||req.headers['sec-fetch-site']==='cross-site'){req.resume();return fail(403,'Cross-site requests are not permitted.');}
    const raw=(req.url||'/').split('?')[0];let pathname;
    try {pathname=decodeURIComponent(raw);}catch{req.resume();return fail(400,'Invalid URL.');}
    if(pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').some(s=>s==='..'||s==='.'||s.startsWith('.'))){req.resume();return fail(403,'Path not permitted.');}
    if(pathname.startsWith('/api/')) {
      if(!['GET','POST','DELETE'].includes(req.method)){req.resume();return fail(405,'Method not permitted.');}
      if(req.method==='GET'&&(req.headers['content-length']||req.headers['transfer-encoding'])){req.resume();return fail(400,'GET body not permitted.');}
      if(req.method==='POST'&&(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'){req.resume();return fail(415,'Only structured JSON is permitted.');}
      if(Number(req.headers['content-length']||0)>4096){req.resume();return fail(413,'Request too large.');}
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>4096){req.resume();return fail(413,'Request too large.');}chunks.push(chunk);}
      const headers={'content-type':'application/json','content-length':size};
      if(req.headers.origin)headers.origin=req.headers.origin;
      if(req.headers['sec-fetch-site'])headers['sec-fetch-site']=req.headers['sec-fetch-site'];
      const upstream=http.request({hostname:'127.0.0.1',port:8000,path:pathname,method:req.method,headers,timeout:15000},response=>{
        if(res.destroyed){response.destroy();return;}
        res.writeHead(response.statusCode||502,{'Content-Type':'application/json'});response.pipe(res);
        response.on('error',()=>res.destroy());
      });
      upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>fail(503,'Server connection failed. Check the laptop backend.'));
      res.on('close',()=>upstream.destroy());upstream.end(Buffer.concat(chunks));return;
    }
    if(!['GET','HEAD'].includes(req.method)){req.resume();return fail(405,'Method not permitted.');}
    if(!/^\/(?:$|index\.html$|icon\.svg$|manifest\.webmanifest$|assets\/[A-Za-z0-9._-]+$|ocr\/(?:worker\.min\.js|eng\.traineddata\.gz|core\/[A-Za-z0-9._-]+)$)/.test(pathname))return fail(404,'Not found.');
    const file=path.join(dist,pathname==='/'?'index.html':pathname.slice(1));
    if(!fs.existsSync(file)||!fs.statSync(file).isFile()||!fs.realpathSync(file).startsWith(fs.realpathSync(dist)+path.sep))return fail(404,'Not found.');
    const type=mime[path.extname(file)];if(!type)return fail(404,'Not found.');
    res.writeHead(200,{'Content-Type':type,'Content-Length':fs.statSync(file).size});
    if(req.method==='HEAD'){res.end();return;}
    fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
  }catch{fail(500,'Request could not be completed.');}
});
server.requestTimeout=20000;server.headersTimeout=10000;server.maxHeadersCount=40;
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port 5173 is busy. Stop the existing server.':'HTTPS server failed to start. Check configuration.');process.exitCode=1;});
server.listen(5173,process.env.SERVER_HOST||'0.0.0.0',()=>console.log(`Phone URL: ${origins.at(-1)} · backend 127.0.0.1:8000`));
