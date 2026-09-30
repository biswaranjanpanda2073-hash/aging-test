import {QRCodeWriter,BarcodeFormat} from '@zxing/library';
import {detectQRFromImage} from '../src/qr';
export async function runGenericQRChecks(){
 const results=[];
 for(const expected of ['T110R4BHK00001','T999R9XYZ12345','https://example.org/qr-test','Local QR validation 123']){
  const matrix=new QRCodeWriter().encode(expected,BarcodeFormat.QR_CODE,320,320,new Map());const c=document.createElement('canvas');c.width=320;c.height=320;const ctx=c.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,320,320);ctx.fillStyle='black';for(let y=0;y<320;y++)for(let x=0;x<320;x++)if(matrix.get(x,y))ctx.fillRect(x,y,1,1);
  const decoded=await detectQRFromImage(c);results.push({expected,decoded,pass:decoded.success&&decoded.data===expected});c.width=c.height=0;
 }return results;
}
