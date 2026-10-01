import fs from 'node:fs';
import path from 'node:path';
import {root,env,certificate} from './runtime.mjs';
certificate();
if(!env.LAN_IP)throw new Error('LAN_IP missing. Run scripts/setup-https.ps1 -LanIP <laptop-IP>.');
for(const asset of ['dist/index.html'])if(!fs.existsSync(path.join(root,asset)))throw new Error(`Required asset missing: ${asset}. Run npm run build.`);
console.log(`Certificate and build checks passed. Phone: https://${env.LAN_IP}:5173`);
console.log('Phone must trust the matching mkcert CA and grant Chrome camera access. This check cannot verify phone settings.');
