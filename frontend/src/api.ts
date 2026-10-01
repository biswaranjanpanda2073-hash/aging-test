import type {Action,Device,Reading} from './types';
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T>(path:string, body?:unknown, signal?:AbortSignal, method?:string):Promise<T> {
  let response:Response;
  const verb = method || (body === undefined ? 'GET' : 'POST');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    response = await fetch('/api'+path, {
      method: verb,
      headers: body === undefined ? {} : {'Content-Type':'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('Server connection failed. Please check the laptop connection.', 0);
  } finally {
    clearTimeout(timeoutId);
  }
  const data = await response.json().catch(()=>null) as {detail?:unknown}|null;
  if (!response.ok) {
    throw new ApiError(typeof data?.detail === 'string' ? data.detail : 'Device information could not be saved. Please try again.', response.status);
  }
  return data as T;
}
export function submit(action:Action,reading:Reading,target?:string) {
  const path = action === 'register' ? '/devices/register' : `/devices/${encodeURIComponent(target || '')}/${/^h[1-4]$/.test(action)?'aging/':''}${action}`;
  return api<Device>(path,reading);
}
