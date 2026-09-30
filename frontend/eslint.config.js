import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(js.configs.recommended, ...ts.configs.recommended, {files:['src/**/*.{ts,tsx}'],languageOptions:{globals:{window:'readonly',document:'readonly',navigator:'readonly',fetch:'readonly',setTimeout:'readonly',clearTimeout:'readonly',setInterval:'readonly',clearInterval:'readonly',HTMLVideoElement:'readonly',HTMLCanvasElement:'readonly',MediaStream:'readonly',DOMException:'readonly',ImageData:'readonly',RequestInit:'readonly',AbortSignal:'readonly',location:'readonly',URL:'readonly',console:'readonly'}}});
