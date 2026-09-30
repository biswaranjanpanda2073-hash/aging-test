import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
export default defineConfig(({mode, command}) => {
  const env = loadEnv(mode, process.cwd(), '');
  const key = path.resolve(env.TLS_KEY || '../certs/lan-key.pem');
  const cert = path.resolve(env.TLS_CERT || '../certs/lan.pem');
  if (command === 'serve' && mode !== 'test' && (!fs.existsSync(key) || !fs.existsSync(cert))) throw new Error('HTTPS certificates missing. Run scripts/setup-https.ps1 first.');
  return {server:{host:'0.0.0.0',port:5173,strictPort:true,cors:false,fs:{strict:true,allow:[process.cwd()],deny:['.env','.env.*','**/*.{pem,key,crt}']},https:command === 'serve' && mode !== 'test' ? {key:fs.readFileSync(key),cert:fs.readFileSync(cert)} : undefined,proxy:{'/api':{target:'http://127.0.0.1:8000',changeOrigin:true}}}};
});
