import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {detectQRFromImage,parseQRSerial} from './qr';
import {detectBatteryPercentage} from './batteryOCR';
import {loadPhoto,clear,rotate,mapGuide,type Rect} from './photo';
import type {Action,Reading} from './types';
export function Scanner({action,target,regex,mode='full',onResult,onCancel}:{action:Action;target?:string;regex:string;mode?:'full'|'battery-only';onResult:(r:Reading)=>void;onCancel:()=>void}){
 const [phase,setPhase]=useState<'qr'|'qr-review'|'battery'|'crop'|'processing'>(mode==='battery-only'?'battery':'qr');
 const [serial,setSerial]=useState(target||''),[error,setError]=useState(''),[status,setStatus]=useState(''),[photo,setPhoto]=useState<HTMLCanvasElement|null>(null),[guide,setGuide]=useState<Rect|null>(null);
 const [scanning,setScanning]=useState(false);
 const input=useRef<HTMLInputElement>(null),preview=useRef<HTMLCanvasElement>(null),serialRef=useRef(target||''),ticket=useRef(''),source=useRef<HTMLCanvasElement|null>(null),start=useRef<{x:number;y:number}|null>(null),live=useRef(true),generation=useRef(0);
 const prepare=async()=>{
  try{
   const result=await api<{capture_token:string}>('/captures',{action,serial_number:action==='register'?null:(serialRef.current||null)});
   if(!live.current)return;
   ticket.current=result.capture_token;
  }catch(e){
   if(live.current){
    console.warn('Capture ticket preparation:', e);
   }
  }
 };
 useEffect(()=>{
  live.current=true;
  if(mode==='battery-only'){
   serialRef.current=target||'';
   setSerial(target||'');
   setPhase('battery');
   void prepare();
  }
  return()=>{live.current=false;generation.current++;if(source.current)clear(source.current);};
 },[mode,target]);
 useEffect(()=>{if(photo&&preview.current){preview.current.width=photo.width;preview.current.height=photo.height;preview.current.getContext('2d')!.drawImage(photo,0,0);}},[photo,phase]);
 const working=phase==='processing'||scanning;
 const release=()=>{if(source.current)clear(source.current);source.current=null;setPhoto(null);setGuide(null);setScanning(false);};
 const selected=async(e:React.ChangeEvent<HTMLInputElement>)=>{
  const file=e.target.files?.[0];e.target.value='';if(!file)return;const id=++generation.current;
  setError('');const isQR=phase==='qr';
  if(isQR){
   setStatus('Decoding QR photo…');setPhase('processing');
   try{
    const result=await detectQRFromImage(file);
    if(!live.current||generation.current!==id)return;
    if(!result.success||result.data===undefined)throw new Error(result.error||'QR not found');
    const value=parseQRSerial(result.data,regex);
    if(target&&value!==target)throw new Error('QR belongs to another device. Expected '+target+'.');
    serialRef.current=value;setSerial(value);setPhase('qr-review');
   }catch(e){
    if(live.current&&generation.current===id){
     setError(e instanceof Error?e.message:'Photo could not be read');
     setPhase('qr');
    }
   }
  }else{
   try{
    setStatus('Loading photo…');
    const c=await loadPhoto(file);
    if(!live.current||generation.current!==id){clear(c);return;}
    release();
    source.current=c;
    setPhoto(c);
    setGuide(null);
    setError('');
    setStatus('');
    setPhase('crop'); // Immediately shows preview!
   }catch(e){
    if(live.current&&generation.current===id){
     setError(e instanceof Error?e.message:'Photo could not be loaded');
     setPhase('battery');
    }
   }
  }
 };
 const read=async(useCrop=true)=>{
  if(!photo)return;const id=++generation.current;setError('');let crop:Rect|undefined;
  if(useCrop&&guide&&preview.current){const b=preview.current.getBoundingClientRect();crop=mapGuide({x:b.x+guide.x*b.width,y:b.y+guide.y*b.height,width:guide.width*b.width,height:guide.height*b.height},b,photo);}
  setStatus(crop?'Reading battery from selected box…':'Scanning battery automatically…');
  setScanning(true);
  try{
   const result=await detectBatteryPercentage(photo,crop);
   if(!live.current||generation.current!==id)return;
   if(!result.success||result.batteryPercent===undefined){
    setScanning(false);
    setError(result.error||(crop?'Could not detect battery digits inside the selected box. Please adjust the green box carefully over only the digits and % symbol, or rotate if text is sideways.':'Could not scan battery automatically. Please drag a green guide box over the battery digits and % symbol (e.g. 84%) to retry.'));
    return;
   }
   const reading={serial_number:serialRef.current,battery_percent:result.batteryPercent,device_timestamp:null,capture_token:ticket.current};
   setScanning(false);
   release();
   onResult(reading);
  }catch(e){
   if(live.current&&generation.current===id){
    setScanning(false);
    setError(e instanceof Error?e.message:'Battery reading failed. Please drag a green guide box over the battery digits to retry.');
   }
  }
 };
 const turn=()=>{if(!photo)return;const c=rotate(photo,90);release();source.current=c;setPhoto(c);setGuide(null);setPhase('crop');};
 const point=(e:React.PointerEvent<HTMLCanvasElement>)=>{const b=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.x)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.y)/b.height))};};
 return <section className="photo-scanner" aria-label="Photo capture">
  <h3>{mode==='battery-only'?'Scan Battery Percentage':phase==='qr'?'1 · Take a QR photo':phase==='qr-review'?'Confirm device':phase==='battery'||phase==='crop'?'2 · Take a battery photo':'Processing photo'}</h3>
  {serial&&<p>Device: <strong>{serial}</strong></p>}
  {error&&<p className="error" role="alert">{error}</p>}
  <input ref={input} type="file" accept="image/*" capture="environment" aria-label={phase==='qr'?'QR photo':'Battery photo'} onChange={e=>void selected(e)} hidden disabled={working}/>
  {phase==='qr'&&<><p>Use the phone camera to photograph the complete QR code in focus.</p><button onClick={()=>input.current?.click()}>Take QR Photo</button></>}
  {phase==='qr-review'&&<><p>Check this serial against the device before continuing.</p><div className="actions"><button onClick={()=>void prepare()}>Confirm serial & continue</button><button className="secondary" onClick={()=>{setSerial('');serialRef.current='';setPhase('qr');}}>Retake QR</button></div></>}
  {phase==='battery'&&<><p>Take a close-up showing the battery digits and % symbol. Keep the same device in front of you.</p><button onClick={()=>input.current?.click()}>Take Battery Photo</button></>}
  {phase==='crop'&&photo&&<>
   <p style={{margin:'6px 0 12px'}}>
     {guide
       ? 'Adjust the green box if needed, then click "⚡ Read Selected Battery Crop".'
       : 'Review your captured photo. Click "⚡ Auto Scan" to read automatically, or drag a green box over the battery digits and % symbol.'}
   </p>
   <div className="photo-preview">
     <canvas
       ref={preview}
       aria-label="Select battery crop"
       onPointerDown={e=>{if(scanning)return;start.current=point(e);e.currentTarget.setPointerCapture(e.pointerId);}}
       onPointerMove={e=>{if(!start.current||scanning)return;const p=point(e),a=start.current;setGuide({x:Math.min(p.x,a.x),y:Math.min(p.y,a.y),width:Math.abs(p.x-a.x),height:Math.abs(p.y-a.y)});}}
       onPointerUp={()=>{start.current=null;}}
       onPointerCancel={()=>{start.current=null;}}
     />
     {guide&&<div className="photo-guide" style={{left:guide.x*100+'%',top:guide.y*100+'%',width:guide.width*100+'%',height:guide.height*100+'%'}}>
       <div className="photo-guide-corner tl" />
       <div className="photo-guide-corner tr" />
       <div className="photo-guide-corner bl" />
       <div className="photo-guide-corner br" />
       <span className="photo-guide-tag">⚡ BATTERY GUIDE</span>
     </div>}
   </div>
   {scanning&&<p role="status" style={{fontWeight:700,color:'#183e2f',margin:'8px 0'}}>⏳ {status}</p>}
   <div className="actions">
     {guide ? (
       <button
         type="button"
         onClick={()=>void read(true)}
         disabled={working || guide.width<.005 || guide.height<.005}
         style={{minHeight:48,flex:2,fontSize:15}}
       >
         ⚡ Read Selected Battery Crop
       </button>
     ) : (
       <button
         type="button"
         onClick={()=>void read(false)}
         disabled={working}
         style={{minHeight:48,flex:2,fontSize:15}}
       >
         ⚡ Auto Scan
       </button>
     )}
     {guide && (
       <button
         type="button"
         className="secondary"
         onClick={()=>void read(false)}
         disabled={working}
         style={{minHeight:48,flex:1,fontSize:15}}
       >
         ⚡ Auto Scan
       </button>
     )}
     <button type="button" className="secondary" onClick={turn} disabled={working}>
       ↺ Rotate Photo
     </button>
     {guide && (
       <button type="button" className="text-button" onClick={()=>setGuide(null)} disabled={working}>
         Clear Guide
       </button>
     )}
     <button type="button" className="text-button" onClick={()=>{release();input.current?.click();}} disabled={working}>
       ＋ Retake Photo
     </button>
   </div>
  </>}
  {phase==='processing'&&<p role="status">{status}</p>}
  <div className="actions"><button className="text-button" onClick={()=>{generation.current++;onCancel();}}>Cancel</button></div>
  <small>Photos are processed locally. Only confirmed readings are sent to the laptop. Your camera app may keep its own photo copy.</small>
 </section>;
}
