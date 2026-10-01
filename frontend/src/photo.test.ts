import {describe,it,expect} from 'vitest';
import {mapGuide} from './photo';
import {parseBatteryPercentage} from './batteryOCR';
describe('strict battery tokens',()=>{
 it.each(['5%','16%','37%','66%','84%','91%','100%','0%'])('accepts %s',s=>expect(parseBatteryPercentage(s)).toBe(Number(s.slice(0,-1))));
 it.each(['Full charge', 'full charge', 'FULL CHARGE', 'Full   charge', '  Full charge  '])('accepts %s as 100', s => expect(parseBatteryPercentage(s)).toBe(100));
 it.each(['84','91','130','54677','12:44','5.5.0','random OCR text','T130R4CIK54677','101%','184%','-1%','12.5%','84% 91%','%84','84 percent','x84%','Charging','Charge','Full','Fast charging'])('rejects %s',s=>expect(parseBatteryPercentage(s)).toBeNull());
});
describe('guide mapping in CSS pixels',()=>{
 it('accounts for contain letterboxing',()=>expect(mapGuide({x:110,y:120,width:100,height:50},{x:10,y:20,width:400,height:400},{width:1600,height:800},'contain',0)).toEqual({x:400,y:0,width:400,height:200}));
 it('accounts for cover cropping',()=>expect(mapGuide({x:0,y:0,width:200,height:200},{x:0,y:0,width:400,height:400},{width:1600,height:800},'cover',0)).toEqual({x:400,y:0,width:400,height:400}));
 it('maps portrait and margins within image bounds',()=>expect(mapGuide({x:100,y:0,width:200,height:400},{x:0,y:0,width:400,height:400},{width:800,height:1600},'contain')).toEqual({x:0,y:0,width:800,height:1600}));
 it('rejects a guide entirely in letterboxing',()=>expect(()=>mapGuide({x:0,y:0,width:10,height:10},{x:0,y:0,width:400,height:400},{width:1600,height:800},'contain',0)).toThrow());
});
