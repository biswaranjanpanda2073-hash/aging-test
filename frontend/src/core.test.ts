import {describe,it,expect,vi,afterEach} from 'vitest';
import {parseSerial,parseBattery,parseTime} from './ocr';
import {cameraDiagnostic,cameraError,CaptureGate,quality} from './camera';
import {api} from './api';
const regex='^T[0-9]{3}R[0-9][A-Z]{3}[0-9]{5}$';
afterEach(()=>vi.unstubAllGlobals());
describe('OCR validation',()=>{
 it('reads serial without substituting characters',()=>expect(parseSerial('T130R4CIK54677\n',regex)).toBe('T130R4CIK54677'));
 it('rejects invalid serial',()=>expect(()=>parseSerial('T13OR4CIK54677',regex)).toThrow());
 it.each(['', '101%', '-1%', '84', '8 4%'])('rejects invalid battery %s',v=>expect(()=>parseBattery(v)).toThrow());
 it('reads 84%',()=>expect(parseBattery('84%')).toBe(84));
 it('normalizes clock spacing without inventing date',()=>expect(parseTime('12:44PM')).toBe('12:44 PM'));
 it('marks unreadable time unavailable',()=>expect(parseTime('25:79')).toBeNull());
});
describe('camera',()=>{
 it('explains insecure context',()=>expect(cameraDiagnostic(false,true)).toContain('HTTPS'));
 it('explains missing camera API',()=>expect(cameraDiagnostic(true,false)).toContain('unavailable'));
 it('explains denied permission',()=>expect(cameraError(new DOMException('','NotAllowedError'))).toContain('permission'));
 it('requires continuous stability and resets countdown',()=>{const gate=new CaptureGate();expect(gate.tick(true,0)).toBe(3);expect(gate.tick(true,2000)).toBe(1);expect(gate.tick(false,2500)).toBeNull();expect(gate.tick(true,3000)).toBe(3);expect(gate.tick(true,6000)).toBe(0);});
 it('rejects a blank frame',()=>expect(quality(new Uint8ClampedArray(400),10).framed).toBe(false));
});
describe('API', () => {
  it('handles unhandled routes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Unhandled route: /unknown-route' }),
    }));
    await expect(api('/unknown-route')).rejects.toThrow('Unhandled route: /unknown-route');
  });
  it('provides config settings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ serial_regex: regex }),
    }));
    const config = await api<{ serial_regex: string }>('/config');
    expect(config.serial_regex).toBeDefined();
  });
  it('generates capture tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ capture_token: 'cap_1234567890' }),
    }));
    const cap = await api<{ capture_token: string }>('/captures');
    expect(cap.capture_token).toContain('cap_');
  });
});
