import {it,expect} from 'vitest';
import {parseQRSerial} from './qr';
const regex='^T[0-9]{3}R[0-9][A-Z]{3}[0-9]{5}$';
it('accepts plain serial QR',()=>expect(parseQRSerial('T130R4CIK54677',regex)).toBe('T130R4CIK54677'));
it('accepts explicit JSON serial field',()=>expect(parseQRSerial('{"serial_number":"T130R4CIK54677"}',regex)).toBe('T130R4CIK54677'));
it.each(['https://example.com/T130R4CIK54677','<script>alert(1)</script>','=1+1','{"serial_number":"T130R4CIK54677","device_id":"T130R4CIK54678"}','{"value":"T130R4CIK54677"}','x'.repeat(1025)])('rejects untrusted or ambiguous QR %s',payload=>expect(()=>parseQRSerial(payload,regex)).toThrow());
