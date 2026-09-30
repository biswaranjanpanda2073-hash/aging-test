import type {Action,Device,Reading} from './types';
export async function api<T>(path:string, body?:unknown, signal?:AbortSignal, method?:string):Promise<T> {
  let response:Response;
  const verb = method || (body === undefined ? 'GET' : 'POST');
  try {
    response = await fetch('/api'+path,{method:verb,headers:body === undefined ? {} : {'Content-Type':'application/json'},body:body === undefined ? undefined:JSON.stringify(body),cache:'no-store',signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)});
  } catch {throw new Error('Server connection failed. Please check the laptop connection.');}
  const data = await response.json().catch(()=>null) as {detail?:unknown}|null;
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Device information could not be saved. Please try again.');
  return data as T;
}
export function submit(action:Action,reading:Reading,target?:string) {
  const path = action === 'register' ? '/devices/register' : `/devices/${encodeURIComponent(target || '')}/${/^h[1-4]$/.test(action)?'aging/':''}${action}`;
  return api<Device>(path,reading);
}
