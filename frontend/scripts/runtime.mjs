import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {isIP} from 'node:net';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const envFile=path.join(root,'.env');
export const env={...(fs.existsSync(envFile)?parseEnv(fs.readFileSync(envFile,'utf8')):{}),...process.env};
if(env.LAN_IP && isIP(env.LAN_IP)!==4)throw new Error('LAN_IP must be the laptop IPv4 address. Run setup-https.ps1 again.');
export const hosts=Array.from(new Set(['localhost','127.0.0.1',...(env.LAN_IP?[env.LAN_IP]:[]),'192.168.137.1']));
export const origins=hosts.map(host=>`https://${host}:5173`);
export function certificate() {
  const key=path.resolve(root,env.TLS_KEY||'../certs/lan-key.pem');
  const cert=path.resolve(root,env.TLS_CERT||'../certs/lan.pem');
  if(!fs.existsSync(key)||!fs.existsSync(cert))throw new Error('HTTPS certificate/key missing. Run scripts/setup-https.ps1 -LanIP <laptop-IP>.');
  const leaf=new X509Certificate(fs.readFileSync(cert));
  if(!leaf.checkPrivateKey(createPrivateKey(fs.readFileSync(key))))throw new Error('HTTPS key and certificate do not match. Run setup-https.ps1 again.');
  if(Date.now()<Date.parse(leaf.validFrom)||Date.now()>Date.parse(leaf.validTo))throw new Error('HTTPS certificate is not currently valid. Regenerate using setup-https.ps1.');
  for(const host of hosts){
    if(!(isIP(host)?leaf.checkIP(host):leaf.checkHost(host)))throw new Error(`HTTPS certificate does not include ${host}. Regenerate using setup-https.ps1.`);
  }
  return {key:fs.readFileSync(key),cert:fs.readFileSync(cert)};
}
export const securityHeaders={
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
