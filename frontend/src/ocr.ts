import {createWorker,PSM,type Worker} from 'tesseract.js';
import type {Fields} from './types';
import {readQR} from './qr';

export const REGIONS = {serial:[0.603,0.175,0.16,0.09],battery:[0.042,0.04,0.04,0.075],time:[0.91,0.04,0.083,0.075],label:[0.346,0.155,0.112,0.149]} as const;
export function parseSerial(text:string,regex:string) {
  const serial = text.replace(/\s/g,'');
  if (serial.length>64 || !new RegExp(`^(?:${regex})$`).test(serial) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(serial)) throw new Error('Could not read Serial Number. Please align the screen and try again.');
  return serial;
}
export function parseBattery(text:string) {
  const match = text.trim().match(/^(\d{1,3})\s*%$/);
  if (!match || Number(match[1])>100) throw new Error('Could not read battery percentage. Please try again.');
  return Number(match[1]);
}
export function parseTime(text:string):string|null {
  const cleaned=text.toUpperCase().replace(/\s/g,'');
  const match=cleaned.match(/^(0?[1-9]|1[0-2]):([0-5]\d)(AM|PM)$/);
  return match ? `${match[1]}:${match[2]} ${match[3]}` : null;
}
export function crop(source:HTMLCanvasElement, region:readonly number[], threshold=false) {
  const [x,y,w,h]=region;
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(source.width*w*3); canvas.height=Math.round(source.height*h*3);
  const ctx=canvas.getContext('2d',{willReadFrequently:true})!;
  ctx.drawImage(source,source.width*x,source.height*y,source.width*w,source.height*h,0,0,canvas.width,canvas.height);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
  for(let i=0;i<pixels.data.length;i+=4){
    const gray=0.299*pixels.data[i]+0.587*pixels.data[i+1]+0.114*pixels.data[i+2];
    const value=threshold ? (gray>140?255:0) : Math.min(255,Math.max(0,(gray-128)*1.6+128));
    pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=value;
  }
  ctx.putImageData(pixels,0,0);pixels.data.fill(0);
  return canvas;
}
export async function newWorker(progress:(message:string)=>void):Promise<Worker> {
  return createWorker('eng',1,{workerPath:'/ocr/worker.min.js',langPath:'/ocr',corePath:'/ocr/core',workerBlobURL:false,cacheMethod:'none',errorHandler:()=>{/* Caller handles rejected jobs; startup has a bounded timeout. */},logger:m=>{if(m.status==='recognizing text')progress(`Reading screen · ${Math.round(m.progress*100)}%`);}});
}
export async function readRegion(worker:Worker,source:HTMLCanvasElement,region:readonly number[],threshold=false,psm:PSM=PSM.SINGLE_LINE){
  const canvas=crop(source,region,threshold);
  try {
    await worker.setParameters({tessedit_pageseg_mode:psm});
    return (await worker.recognize(canvas)).data;
  } finally {canvas.width=0;canvas.height=0;}
}
export async function recognize(source:HTMLCanvasElement,regex:string,progress:(message:string)=>void,existingWorker?:Worker):Promise<Fields> {
  const worker=existingWorker || await newWorker(progress);
  try {
    progress('Reading serial from QR code…');
    const serial=readQR(source,regex);
    progress('QR read · reading top-left battery percentage…');
    for(const threshold of [false,true]) {
      try {
        const battery=await readRegion(worker,source,REGIONS.battery,threshold);
        if(battery.confidence<65)throw new Error('Reading is unclear. Hold steady and try again.');
        const time=await readRegion(worker,source,REGIONS.time,threshold);
        return {serial_number:serial,battery_percent:parseBattery(battery.text),device_timestamp:time.confidence>=65?parseTime(time.text):null};
      } catch(error){if(threshold)throw error;}
    }
    throw new Error('Could not read the screen. Please retry.');
  } finally {if(!existingWorker)await worker.terminate();source.width=0;source.height=0;}
}
