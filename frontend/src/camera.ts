export function cameraDiagnostic(secure:boolean,available:boolean) {
  if(!secure)return 'Camera requires trusted HTTPS. Open the laptop HTTPS address and install its development CA on this phone.';
  if(!available)return 'Camera is unavailable in this browser. Use Android Chrome with a trusted HTTPS connection.';
  return null;
}
export function errorName(error:unknown):string {
  if(typeof error==='object' && error!==null && 'name' in error && typeof error.name==='string' && /^[A-Za-z]{1,40}$/.test(error.name))return error.name;
  return 'UnknownError';
}
export function cameraError(error:unknown) {
  switch(errorName(error)) {
    case 'NotAllowedError': return 'Camera permission was blocked. Allow camera access in Android and Chrome site settings, and check that HTTPS is trusted.';
    case 'NotFoundError': return 'No camera was found on this device.';
    case 'NotReadableError': return 'The camera could not be started. Close other camera apps and check Android camera access.';
    case 'OverconstrainedError': return 'This camera cannot use the requested settings. Try another camera or browser.';
    case 'SecurityError': return 'Camera access is blocked by browser security. Check the HTTPS certificate and device policy.';
    case 'AbortError': return 'Camera startup was interrupted. Tap Retry camera.';
    case 'TimeoutError': return 'Camera preview did not become ready. Check camera permission and tap Retry camera.';
    default: return 'Camera startup failed. Check the diagnostic code below and retry.';
  }
}
export function stopStream(stream:MediaStream|null) {stream?.getTracks().forEach(track=>track.stop());}
export function abortable<T>(promise:Promise<T>,signal:AbortSignal,timeout=0):Promise<T> {
  return new Promise((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const cleanup=()=>{signal.removeEventListener('abort',abort);clearTimeout(timer);};
    const abort=()=>{cleanup();reject(new DOMException('Cancelled','AbortError'));};
    if(signal.aborted){promise.catch(()=>{});abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    if(timeout)timer=setTimeout(()=>{cleanup();reject(new DOMException('Timed out','TimeoutError'));},timeout);
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
// Serialize browser permission requests even when a component is cancelled.
let cameraQueue:Promise<void>=Promise.resolve();
export function openCamera(media:Pick<MediaDevices,'getUserMedia'>,signal:AbortSignal):Promise<MediaStream> {
  const pending=cameraQueue.then(async()=>{
    signal.throwIfAborted();
    let stream:MediaStream;
    try {stream=await media.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});}
    catch(error){
      signal.throwIfAborted();
      if(errorName(error)!=='OverconstrainedError')throw error;
      stream=await media.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
    }
    if(signal.aborted){stopStream(stream);signal.throwIfAborted();}
    return stream;
  });
  cameraQueue=pending.then(()=>{},()=>{});
  return abortable(pending,signal);
}
export async function startPreview(video:HTMLVideoElement,stream:MediaStream,signal:AbortSignal) {
  signal.throwIfAborted();video.muted=true;video.playsInline=true;video.srcObject=stream;
  await abortable(video.play(),signal,12000);
  if(video.videoWidth>0&&video.videoHeight>0)return;
  await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);video.removeEventListener('loadeddata',check);signal.removeEventListener('abort',abort);};
    const check=()=>{if(video.videoWidth>0&&video.videoHeight>0){cleanup();resolve();}};
    const abort=()=>{cleanup();reject(new DOMException('Cancelled','AbortError'));};
    const timer=setTimeout(()=>{cleanup();reject(new DOMException('No preview dimensions','TimeoutError'));},12000);
    video.addEventListener('loadeddata',check);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();else check();
  });
}
// The guide occupies 90% of the displayed camera width. Video is never cropped by CSS.
export function frame(video:HTMLVideoElement) {
  const width=video.videoWidth*0.9;
  const height=width/(1536/516);
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(width);canvas.height=Math.round(height);
  canvas.getContext('2d')!.drawImage(video,(video.videoWidth-width)/2,(video.videoHeight-height)/2,width,height,0,0,canvas.width,canvas.height);
  return canvas;
}
export function quality(pixels:Uint8ClampedArray,width:number,previous?:Uint8ClampedArray) {
  let motion=0,edge=0,green=0,light=0,leftCount=0,rightCount=0;
  for(let i=0;i<pixels.length;i+=4){
    const x=(i/4)%width,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    if(previous)motion+=Math.abs(r-previous[i])+Math.abs(g-previous[i+1])+Math.abs(b-previous[i+2]);
    if(x>0)edge+=Math.abs(r-pixels[i-4]);
    if(x<width*0.3){leftCount++;if(g>r*0.9&&g>b*1.3&&g>60)green++;}
    else {rightCount++;if(r>110&&g>110&&b>90)light++;}
  }
  const count=pixels.length/4;
  return {stable:!!previous&&motion/(count*3)<9,sharp:edge/count>5,framed:green/leftCount>0.35&&light/rightCount>0.4};
}
export class CaptureGate {
  private since:number|null=null;
  reset(){this.since=null;}
  tick(suitable:boolean,time:number) {
    if(!suitable){this.reset();return null;}
    if(this.since===null)this.since=time;
    return Math.max(0,3-Math.floor((time-this.since)/1000));
  }
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Extracts a normalized rectangular crop from a playing video onto an in-memory canvas.
 * Clamps coordinates to valid video dimensions and optionally downscales to bounded size.
 */
export function cropVideoFrame(
  video: HTMLVideoElement,
  guideRect: NormalizedRect,
  maxDimension = 640
): HTMLCanvasElement {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const sx = Math.max(0, Math.min(vw - 1, Math.floor(guideRect.x * vw)));
  const sy = Math.max(0, Math.min(vh - 1, Math.floor(guideRect.y * vh)));
  const sw = Math.max(1, Math.min(vw - sx, Math.ceil(guideRect.width * vw)));
  const sh = Math.max(1, Math.min(vh - sy, Math.ceil(guideRect.height * vh)));

  let dw = sw;
  let dh = sh;
  if (Math.max(dw, dh) > maxDimension) {
    const scale = maxDimension / Math.max(dw, dh);
    dw = Math.max(1, Math.round(dw * scale));
    dh = Math.max(1, Math.round(dh * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, dw);
  canvas.height = Math.max(1, dh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * Evaluates frame quality estimates (motion, brightness, glare) on a cropped canvas.
 * Note: These are software heuristics, not confirmed hardware focus.
 */
export function assessCropQuality(
  canvas: HTMLCanvasElement,
  previousPixels?: Uint8ClampedArray
): {
  guidance: string | null;
  pixels: Uint8ClampedArray;
  motion: number;
  brightness: number;
} {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { guidance: null, pixels: new Uint8ClampedArray(0), motion: 0, brightness: 128 };
  }
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  let totalBrightness = 0;
  let motion = 0;
  let clippedHigh = 0;
  const pixelCount = Math.max(1, data.length / 4);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = (r * 299 + g * 587 + b * 114) / 1000;
    totalBrightness += luma;
    if (luma > 248) clippedHigh++;
    if (previousPixels && previousPixels.length === data.length) {
      motion += Math.abs(r - previousPixels[i]) + Math.abs(g - previousPixels[i + 1]) + Math.abs(b - previousPixels[i + 2]);
    }
  }

  const avgBrightness = totalBrightness / pixelCount;
  const avgMotion = previousPixels ? motion / (pixelCount * 3) : 0;
  const glareRatio = clippedHigh / pixelCount;

  let guidance: string | null = null;
  if (previousPixels && avgMotion > 20) {
    guidance = 'Hold steady';
  } else if (glareRatio > 0.40) {
    guidance = 'Reduce glare (tilt phone slightly)';
  } else if (avgBrightness < 35) {
    guidance = 'Move closer or increase lighting';
  }

  return { guidance, pixels: data, motion: avgMotion, brightness: avgBrightness };
}

