import {describe,it,expect,vi,afterEach} from 'vitest';
import {openCamera,stopStream,startPreview,abortable,errorName,cameraError} from './camera';
import {parseSerial} from './ocr';
function stream(){const stop=vi.fn();return {value:{getTracks:()=>[{stop}]} as unknown as MediaStream,stop};}
afterEach(()=>vi.useRealTimers());
describe('camera lifecycle',()=>{
 it('falls back only for unsupported constraints',async()=>{const s=stream(),getUserMedia=vi.fn().mockRejectedValueOnce({name:'OverconstrainedError'}).mockResolvedValueOnce(s.value);expect(await openCamera({getUserMedia},new AbortController().signal)).toBe(s.value);expect(getUserMedia).toHaveBeenCalledTimes(2);expect(getUserMedia.mock.calls[1][0]).toEqual({audio:false,video:{facingMode:{ideal:'environment'}}});});
 it('does not repeat a denied permission prompt',async()=>{const getUserMedia=vi.fn().mockRejectedValue({name:'NotAllowedError'});await expect(openCamera({getUserMedia},new AbortController().signal)).rejects.toMatchObject({name:'NotAllowedError'});expect(getUserMedia).toHaveBeenCalledTimes(1);});
 it('stops a late stream from a cancelled permission request before retrying',async()=>{
   const old=stream(),fresh=stream(),first=new AbortController();let resolve!:(value:MediaStream)=>void;
   const getUserMedia=vi.fn().mockImplementationOnce(()=>new Promise<MediaStream>(r=>{resolve=r;})).mockResolvedValueOnce(fresh.value);
   const firstResult=openCamera({getUserMedia},first.signal).catch(e=>e);await Promise.resolve();first.abort();
   const secondResult=openCamera({getUserMedia},new AbortController().signal);
   resolve(old.value);expect((await firstResult).name).toBe('AbortError');expect(await secondResult).toBe(fresh.value);
   expect(old.stop).toHaveBeenCalledOnce();expect(fresh.stop).not.toHaveBeenCalled();
 });
 it('stops all tracks',()=>{const s=stream();stopStream(s.value);expect(s.stop).toHaveBeenCalledOnce();});
 it('does not request a camera after cancellation',async()=>{const control=new AbortController();control.abort();const getUserMedia=vi.fn();await expect(openCamera({getUserMedia},control.signal)).rejects.toMatchObject({name:'AbortError'});expect(getUserMedia).not.toHaveBeenCalled();});
 it('distinguishes preview play rejection',async()=>{const s=stream();const video={play:vi.fn().mockRejectedValue(new DOMException('','NotAllowedError'))} as unknown as HTMLVideoElement;await expect(startPreview(video,s.value,new AbortController().signal)).rejects.toMatchObject({name:'NotAllowedError'});expect(video.srcObject).toBe(s.value);});
 it('times out pending preview playback',async()=>{vi.useFakeTimers();const s=stream();const video={play:()=>new Promise<void>(()=>{})} as unknown as HTMLVideoElement;const result=startPreview(video,s.value,new AbortController().signal).catch(e=>e);await vi.advanceTimersByTimeAsync(12001);expect(await result).toMatchObject({name:'TimeoutError'});});
 it('bounds pending OCR waits',async()=>{vi.useFakeTimers();const result=abortable(new Promise(()=>{}),new AbortController().signal,100).catch(e=>e);await vi.advanceTimersByTimeAsync(101);expect(await result).toMatchObject({name:'TimeoutError'});});
 it.each(['NotAllowedError','NotFoundError','NotReadableError','OverconstrainedError','SecurityError','AbortError'])('recognizes plain-object browser error %s',name=>{expect(errorName({name})).toBe(name);expect(cameraError({name})).not.toContain('diagnostic code');});
 it('does not display arbitrary error text',()=>{expect(errorName({name:'<script>alert(1)</script>'})).toBe('UnknownError');expect(cameraError({name:'bad',message:'secret'})).not.toContain('secret');});
 it.each(['=1+1','-123','@SUM(1)','../../test','<script>alert(1)</script>','x'.repeat(65)])('blocks unsafe OCR serial even with permissive config: %s',serial=>expect(()=>parseSerial(serial,'.*')).toThrow());
});
