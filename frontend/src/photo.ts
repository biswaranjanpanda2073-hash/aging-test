export type Rect={x:number;y:number;width:number;height:number};
export type Photo=File|HTMLImageElement|HTMLCanvasElement;
export function canvas(width:number,height:number){const c=document.createElement('canvas');c.width=Math.max(1,Math.round(width));c.height=Math.max(1,Math.round(height));return c;}
export async function loadPhoto(source:Photo):Promise<HTMLCanvasElement>{
 if(source instanceof HTMLCanvasElement)return source;
 let img:HTMLImageElement,url:string|undefined;
 if(source instanceof File){if(source.size>25*1024*1024)throw new Error('Photo exceeds 25 MB. Use a smaller camera resolution.');img=new Image();url=URL.createObjectURL(source);img.src=url;}else img=source;
 try{await img.decode();const w=img.naturalWidth,h=img.naturalHeight;if(!w||!h||w*h>48000000)throw new Error('Photo dimensions are unsupported. Use a smaller camera resolution.');const c=canvas(w,h);c.getContext('2d')!.drawImage(img,0,0);return c;}finally{if(url)URL.revokeObjectURL(url);}
}
export function clear(c:HTMLCanvasElement){c.width=0;c.height=0;}
export function cropPhoto(c:HTMLCanvasElement,r:Rect,max=1600){const s=Math.min(3,max/Math.max(r.width,r.height));const out=canvas(r.width*s,r.height*s);out.getContext('2d')!.drawImage(c,r.x,r.y,r.width,r.height,0,0,out.width,out.height);return out;}
export function rotate(c:HTMLCanvasElement,degrees:number){const a=degrees*Math.PI/180,cos=Math.abs(Math.cos(a)),sin=Math.abs(Math.sin(a));const out=canvas(c.width*cos+c.height*sin,c.width*sin+c.height*cos),ctx=out.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,out.width,out.height);ctx.translate(out.width/2,out.height/2);ctx.rotate(a);ctx.drawImage(c,-c.width/2,-c.height/2);return out;}
// Guide values and box are CSS pixels. DPR cancels: natural pixels / rendered CSS pixels.
export function mapGuide(guide:Rect,box:Rect,natural:{width:number;height:number},fit:'contain'|'cover'='contain',margin=.08):Rect{
 const s=(fit==='contain'?Math.min:Math.max)(box.width/natural.width,box.height/natural.height);
 if(!(s>0)||guide.width<=0||guide.height<=0)throw new Error('Select a battery crop inside the photo.');
 const ox=(box.width-natural.width*s)/2,oy=(box.height-natural.height*s)/2;
 const x=(guide.x-box.x-ox)/s,y=(guide.y-box.y-oy)/s,w=guide.width/s,h=guide.height/s;
 const left=Math.max(0,x-w*margin),top=Math.max(0,y-h*margin),right=Math.min(natural.width,x+w*(1+margin)),bottom=Math.min(natural.height,y+h*(1+margin));
 if(right<=left||bottom<=top)throw new Error('Battery guide is outside the photo.');
 return {x:Math.floor(left),y:Math.floor(top),width:Math.ceil(right-left),height:Math.ceil(bottom-top)};
}
