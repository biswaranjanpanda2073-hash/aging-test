import jsQR from 'jsqr';
import {QRCodeReader,RGBLuminanceSource,HybridBinarizer,BinaryBitmap,DecodeHintType,BarcodeFormat,MultiFormatReader} from '@zxing/library';
import {loadPhoto,cropPhoto,clear,type Photo,type Rect} from './photo';
export function parseQRSerial(payload:string,regex:string):string {
  if(payload.length>1024)throw new Error('QR payload is too large.');
  let value=payload.trim();
  if(value.startsWith('{')){
    let data:unknown;try{data=JSON.parse(value);}catch{throw new Error('QR content is invalid.');}
    if(typeof data!=='object'||data===null||Array.isArray(data))throw new Error('QR content is invalid.');
    const record=data as Record<string,unknown>;
    const values=['serial_number','serialNumber','device_id'].filter(key=>Object.hasOwn(record,key)).map(key=>record[key]);
    if(values.length!==1||typeof values[0]!=='string')throw new Error('QR must contain one unambiguous serial number.');
    value=values[0].trim();
  }
  if(value.length>64||!new RegExp(`^(?:${regex})$`).test(value)||!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value))throw new Error('QR does not contain a valid device serial number.');
  return value;
}

export interface QRResult {success:boolean;data?:string;region?:string;attempts:number;processingTime:number;error?:string;trace:{method:string;milliseconds:number;decoded:boolean}[]}
export async function detectQRFromImage(input:Photo):Promise<QRResult>{
 const start=performance.now(),trace:QRResult['trace']=[];let source:HTMLCanvasElement|undefined;
 try{
  source=await loadPhoto(input);
  const w=source.width,h=source.height;
  const regions:{name:string;rect:Rect;size:number;contrast?:boolean}[]=[
   {name:'full-image',rect:{x:0,y:0,width:w,height:h},size:1200},
   {name:'right-side',rect:{x:w*.75,y:0,width:w*.25,height:h},size:1000},
   {name:'full-image-1800',rect:{x:0,y:0,width:w,height:h},size:1800},
   {name:'right-half-native',rect:{x:w*.5,y:0,width:w*.5,height:h},size:3000},
   {name:'full-image-3000',rect:{x:0,y:0,width:w,height:h},size:3000},
   {name:'center-expanded',rect:{x:w*.1,y:h*.1,width:w*.8,height:h*.8},size:1400},
  ];
  for(const y of [0,.4])for(const x of [0,.4])regions.push({name:`tile-${x}-${y}`,rect:{x:w*x,y:h*y,width:w*.6,height:h*.6},size:1400});
  regions.push({name:'right-side-contrast',rect:regions[1].rect,size:1400,contrast:true},{name:'full-image-contrast',rect:regions[0].rect,size:1600,contrast:true});
  const Native=(globalThis as unknown as {BarcodeDetector?:new(options:{formats:string[]})=>{detect:(c:HTMLCanvasElement)=>Promise<{rawValue:string}[]>}}).BarcodeDetector;
  if(Native){const c=cropPhoto(source,regions[0].rect,1600),at=performance.now();try{const codes=await Promise.race([new Native({formats:['qr_code']}).detect(c),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Native QR timeout')),1500))]);trace.push({method:'BarcodeDetector',milliseconds:performance.now()-at,decoded:!!codes[0]});if(codes[0])return {success:true,data:codes[0].rawValue,region:'BarcodeDetector',attempts:trace.length,processingTime:performance.now()-start,trace};}catch{trace.push({method:'BarcodeDetector unavailable/failed',milliseconds:performance.now()-at,decoded:false});}finally{clear(c);}}
  for(const r of regions){
   await new Promise(resolve=>setTimeout(resolve,0));
   const c=cropPhoto(source,r.rect,r.size),ctx=c.getContext('2d',{willReadFrequently:true})!,pixels=ctx.getImageData(0,0,c.width,c.height),at=performance.now();
   try{
    if(r.contrast)for(let i=0;i<pixels.data.length;i+=4){const v=(pixels.data[i]*.299+pixels.data[i+1]*.587+pixels.data[i+2]*.114-128)*1.7+128;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=v;}
    const result=jsQR(pixels.data,c.width,c.height,{inversionAttempts:'attemptBoth'});
    trace.push({method:r.name,milliseconds:performance.now()-at,decoded:!!result});
    if(result)return {success:true,data:result.data,region:r.name,attempts:trace.length,processingTime:performance.now()-start,trace};
   }finally{pixels.data.fill(0);clear(c);}
  }
  for(const [name,rect,size] of [['full',regions[0].rect,1600],['right-half',regions[3].rect,2400],['full-detail',regions[0].rect,3000]] as const){
   await new Promise(resolve=>setTimeout(resolve,0));const c=cropPhoto(source,rect,size),pixels=c.getContext('2d')!.getImageData(0,0,c.width,c.height),gray=new Uint8ClampedArray(c.width*c.height),at=performance.now();
   try{for(let i=0;i<gray.length;i++)gray[i]=(pixels.data[i*4]+2*pixels.data[i*4+1]+pixels.data[i*4+2])/4;const reader=new QRCodeReader();try{const result=reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray,c.width,c.height))),new Map([[DecodeHintType.TRY_HARDER,true]]));trace.push({method:'ZXing-'+name,milliseconds:performance.now()-at,decoded:true});return {success:true,data:result.getText(),region:'ZXing-'+name,attempts:trace.length,processingTime:performance.now()-start,trace};}finally{reader.reset();}}
   catch{trace.push({method:'ZXing-'+name,milliseconds:performance.now()-at,decoded:false});}finally{gray.fill(0);pixels.data.fill(0);clear(c);}
  }
  return {success:false,error:'QR decoding exhausted full-image, region and contrast attempts. Retake with the complete QR in focus.',attempts:trace.length,processingTime:performance.now()-start,trace};
 }catch(e){return {success:false,error:e instanceof Error?e.message:'Image decode failed',attempts:trace.length,processingTime:performance.now()-start,trace};}
 finally{if(source&&source!==input)clear(source);}
}
// Kept for legacy reference tests; the application calls the asynchronous photo decoder.
export function readQR(source:HTMLCanvasElement,regex:string){const p=source.getContext('2d')!.getImageData(0,0,source.width,source.height);try{const qr=jsQR(p.data,p.width,p.height,{inversionAttempts:'attemptBoth'});if(!qr)throw new Error('QR not detected');return parseQRSerial(qr.data,regex);}finally{p.data.fill(0);}}

/**
 * Fast in-memory live barcode and QR code decoder from an HTMLCanvasElement.
 * Priority: Native BarcodeDetector -> jsQR -> ZXing MultiFormatReader.
 * Returns decoded string or null if no valid code was found.
 */
export async function decodeCodeFromCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;

  // 1. Native BarcodeDetector (instant hardware decoding in Android Chrome / Chromium)
  const Native = (globalThis as unknown as {
    BarcodeDetector?: new(options: { formats: string[] }) => {
      detect: (c: HTMLCanvasElement) => Promise<{ rawValue: string }[]>;
    };
  }).BarcodeDetector;

  if (Native) {
    try {
      const detector = new Native({
        formats: [
          'qr_code',
          'code_128',
          'code_39',
          'code_93',
          'ean_13',
          'ean_8',
          'itf',
          'data_matrix',
          'upc_a',
          'upc_e',
        ],
      });
      const results = await detector.detect(canvas);
      if (results && results.length > 0 && results[0].rawValue) {
        return results[0].rawValue.trim();
      }
    } catch {
      // Fall through to jsQR
    }
  }

  // 2. jsQR (extremely fast in-browser QR decoder ~2-5ms)
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    try {
      const result = jsQR(imgData.data, canvas.width, canvas.height, {
        inversionAttempts: 'attemptBoth',
      });
      if (result && result.data && result.data.trim()) {
        return result.data.trim();
      }
    } catch {
      // Fall through to ZXing
    }

    // 3. ZXing MultiFormatReader for 1D barcodes and complex 2D codes
    try {
      const gray = new Uint8ClampedArray(canvas.width * canvas.height);
      const data = imgData.data;
      for (let i = 0; i < gray.length; i++) {
        gray[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
      }
      const luminanceSource = new RGBLuminanceSource(gray, canvas.width, canvas.height);
      const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.QR_CODE,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.CODE_93,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.DATA_MATRIX,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
      ]);
      const reader = new MultiFormatReader();
      reader.setHints(hints);
      try {
        const zxingResult = reader.decode(binaryBitmap);
        if (zxingResult && zxingResult.getText()) {
          return zxingResult.getText().trim();
        }
      } finally {
        reader.reset();
      }
    } catch {
      // None detected
    }
  }

  return null;
}

