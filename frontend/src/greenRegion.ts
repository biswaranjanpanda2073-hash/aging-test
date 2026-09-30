import {canvas,clear,type Rect} from './photo';
type Point={x:number;y:number};
export type Panel={cx:number;cy:number;width:number;height:number;angle:number;bounds:Rect};
// Locate the lime-green panel by pixels, without relying on its position in the photograph.
export function greenPanel(source:HTMLCanvasElement):Panel|null{
 const scale=Math.min(1,600/Math.max(source.width,source.height)),c=canvas(source.width*scale,source.height*scale),ctx=c.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(source,0,0,c.width,c.height);
 const {data}=ctx.getImageData(0,0,c.width,c.height),w=c.width,h=c.height,mask=new Uint8Array(w*h);let best:number[]=[];
 for(let i=0;i<mask.length;i++){const [r,g,b]=data.slice(i*4,i*4+3);mask[i]=g>55&&g>r*.90&&g>b*1.3&&r>g*.40?1:0;}
 const queue=new Int32Array(w*h);
 for(let i=0;i<mask.length;i++)if(mask[i]){let head=0,tail=1;queue[0]=i;mask[i]=0;const points:number[]=[];while(head<tail){const n=queue[head++];points.push(n);const x=n%w;for(const k of [x>0?n-1:-1,x<w-1?n+1:-1,n-w,n+w])if(k>=0&&k<mask.length&&mask[k]){mask[k]=0;queue[tail++]=k;}}if(points.length>best.length)best=points;}
 data.fill(0);clear(c);if(best.length<w*h*.004)return null;
 const rows=new Map<number,[number,number]>();for(const n of best){const y=Math.floor(n/w),x=n%w,a=rows.get(y);if(a){a[0]=Math.min(a[0],x);a[1]=Math.max(a[1],x);}else rows.set(y,[x,x]);}
 const pts:Point[]=[];for(const [y,a]of rows){pts.push({x:a[0],y},{x:a[1],y});}pts.sort((a,b)=>a.x-b.x||a.y-b.y);
 const cross=(a:Point,b:Point,p:Point)=>(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
 const half=(arr:Point[])=>{const q:Point[]=[];for(const p of arr){while(q.length>1&&cross(q[q.length-2],q[q.length-1],p)<=0)q.pop();q.push(p);}q.pop();return q;};
 const hull=[...half(pts),...half([...pts].reverse())];let area=Infinity,result:Panel|null=null;
 for(let i=0;i<hull.length;i++){const a=hull[i],b=hull[(i+1)%hull.length],ang=Math.atan2(b.y-a.y,b.x-a.x),cos=Math.cos(ang),sin=Math.sin(ang);let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const p of hull){const x=p.x*cos+p.y*sin,y=-p.x*sin+p.y*cos;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  const size=(maxX-minX)*(maxY-minY);if(size<area){area=size;const x=(minX+maxX)/2,y=(minY+maxY)/2;result={cx:(x*cos-y*sin)/scale,cy:(x*sin+y*cos)/scale,width:(maxX-minX)/scale,height:(maxY-minY)/scale,angle:ang,bounds:{x:Math.min(...hull.map(p=>p.x))/scale,y:Math.min(...hull.map(p=>p.y))/scale,width:(Math.max(...hull.map(p=>p.x))-Math.min(...hull.map(p=>p.x)))/scale,height:(Math.max(...hull.map(p=>p.y))-Math.min(...hull.map(p=>p.y)))/scale}};}
 }
 return result;
}
export function extractPanel(source:HTMLCanvasElement,p:Panel){const out=canvas(p.width,p.height),ctx=out.getContext('2d')!;ctx.translate(out.width/2,out.height/2);ctx.rotate(-p.angle);ctx.drawImage(source,-p.cx,-p.cy);return out;}
