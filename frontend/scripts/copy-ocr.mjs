import {cpSync,mkdirSync} from 'node:fs';
mkdirSync('public/ocr',{recursive:true});
cpSync('node_modules/tesseract.js/dist/worker.min.js','public/ocr/worker.min.js');
cpSync('node_modules/tesseract.js-core','public/ocr/core',{recursive:true});
cpSync('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz','public/ocr/eng.traineddata.gz');
console.log('Local OCR assets prepared. No external OCR service is used.');
