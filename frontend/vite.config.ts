import { defineConfig, loadEnv } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function versionPlugin() {
  return {
    name: 'generate-version-json',
    buildStart() {
      const buildTime = Date.now();
      const versionData = {
        version: '1.3.0',
        buildTime,
        buildId: `v1.3.0_${buildTime}`,
      };
      const publicDir = path.resolve(process.cwd(), 'public');
      if (fs.existsSync(publicDir)) {
        fs.writeFileSync(path.join(publicDir, 'version.json'), JSON.stringify(versionData, null, 2));
      }
    },
    closeBundle() {
      const distDir = path.resolve(process.cwd(), 'dist');
      if (fs.existsSync(distDir)) {
        const buildTime = Date.now();
        const versionData = {
          version: '1.3.0',
          buildTime,
          buildId: `v1.3.0_${buildTime}`,
        };
        fs.writeFileSync(path.join(distDir, 'version.json'), JSON.stringify(versionData, null, 2));
      }
    }
  };
}

export default defineConfig(({mode, command}) => {
  const env = loadEnv(mode, process.cwd(), '');
  const key = path.resolve(env.TLS_KEY || '../certs/lan-key.pem');
  const cert = path.resolve(env.TLS_CERT || '../certs/lan.pem');
  if (command === 'serve' && mode !== 'test' && (!fs.existsSync(key) || !fs.existsSync(cert))) {
    // If running in development without certs, log warning rather than throwing hard crash if test mode
    console.warn('Note: HTTPS certificates not found. Run scripts/setup-https.ps1 for LAN testing.');
  }

  const buildTime = Date.now();

  return {
    plugins: [versionPlugin()],
    define: {
      __APP_BUILD_TIME__: JSON.stringify(buildTime),
      __APP_VERSION__: JSON.stringify('1.3.0'),
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      cors: false,
      fs: {
        strict: true,
        allow: [process.cwd()],
        deny: ['.env', '.env.*', '**/*.{pem,key,crt}'],
      },
      https: command === 'serve' && mode !== 'test' && fs.existsSync(key) && fs.existsSync(cert)
        ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
        : undefined,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:5001/agingtest-57600/us-central1/api',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api/, ''),
        },
      },
    },
  };
});
