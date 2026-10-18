// Closed, complete limb surfaces. No texture triangles span separate limbs.
// Faces, hair, hands and footwear are rigid samples of the approved artwork.
import {PARTS,rot} from './motion.mjs';
const part=Object.fromEntries(PARTS.map(p=>[p.id,p]));
const add=(a,b)=>[a[0]+b[0],a[1]+b[1]],sub=(a,b)=>[a[0]-b[0],a[1]-b[1]],mul=(a,t)=>[a[0]*t,a[1]*t];
const unit=a=>mul(a,1/Math.max(.001,Math.hypot(...a))),lerp=(a,b,t)=>add(mul(a,1-t),mul(b,t));
export const PALETTE={skin:'#ffbe84',coral:'#ff7058',green:'#8ece57',yellow:'#f9dc02',purple:'#d6acf2'};
// Purple belongs to the overlapping male trousers, never to her white/yellow shoe.
export const isShoeOccluder=(r,g,b)=>b>g+12&&r>g+8&&b>r-12;
export function mapped(s,id,q){const t=s.parts[id];return add(t.pos,rot(sub(q,part[id].pivot),t.rotation));}
export function neckPoints(s,who){
 const axis=rot(unit(who==='g'?[-.35,-.94]:[-.4,-.9165]),s.parts[who+'-body'].rotation);
 const base=s.parts[who+'-head'].pos;
 // Reference: chin close to the collar, not a lifted head on a long stalk.
 const offset=mul(axis,-8);
 return {base,top:add(base,offset),offset,
  collar:who==='b'?mapped(s,'b-body',[1004,455]):add(base,rot([0,8],s.parts['g-body'].rotation)),
  jaw:who==='b'?add(mapped(s,'b-head',[996,433]),offset):add(base,offset)};
}
export function createCompleteRig(canvas,texture){
 const ctx=canvas.getContext('2d');
 const patches={
  'g-head':part['g-head'].poly,'b-head':part['b-head'].poly,
  'g-front-shoe':[[727,659],[776,670],[815,700],[815,788],[705,796],[699,738]],
  // The previous inward notch at (980,750) removed real shoe pixels.
  // Keep the complete white upper and yellow sole, including the outer heel.
  'g-back-shoe':[[955,693],[993,693],[1025,730],[1025,833],[939,833],[939,737]],
  'b-front-shoe':[[1089,718],[1150,733],[1154,851],[1049,854],[1048,783],[1065,752]],
  'b-back-shoe':[[1170,516],[1190,506],[1256,541],[1270,613],[1206,619],[1160,585],[1158,550]],
  'joined-hands':part['joined-hands'].poly,
  'g-front-hand':[[535,440],[638,440],[638,540],[535,540]],
  'b-free-hand':[[1176,393],[1283,393],[1283,484],[1176,484]],
 };
 const patchData={};
 for(const [id,poly] of Object.entries(patches)){
  const xs=poly.map(v=>v[0]),ys=poly.map(v=>v[1]),x=Math.floor(Math.min(...xs)),y=Math.floor(Math.min(...ys));
  const im=document.createElement('canvas');im.width=Math.ceil(Math.max(...xs))-x+1;im.height=Math.ceil(Math.max(...ys))-y+1;
  const c=im.getContext('2d');c.translate(-x,-y);c.beginPath();poly.forEach((p,i)=>i?c.lineTo(...p):c.moveTo(...p));c.closePath();c.clip();c.drawImage(texture,0,0);
  if(id.endsWith('-head')){
   // Old collars accidentally included in the head mask rotated separately
   // from the shirt. Remove only garment-colour pixels below the face.
   const pixels=c.getImageData(0,0,im.width,im.height),d=pixels.data;
   for(let k=0;k<d.length;k+=4){const sy=y+Math.floor(k/4/im.width),r=d[k],g=d[k+1],b=d[k+2];if(id==='g-head'?sy>469&&r>g*1.5&&g<166&&b<145:sy>426&&g>r*1.1&&g>b*1.12)d[k+3]=0;}
  c.putImageData(pixels,0,0);
  }
  if(id==='g-back-shoe'){
   const pixels=c.getImageData(0,0,im.width,im.height),d=pixels.data;
   for(let k=0;k<d.length;k+=4)if(isShoeOccluder(d[k],d[k+1],d[k+2]))d[k+3]=0;
   c.putImageData(pixels,0,0);
   // Reconstruct the hidden heel UNDER the retained original shoe pixels.
   // Merely erasing purple would leave the same diagonal missing wedge.
   c.save();c.globalCompositeOperation='destination-over';
   c.fillStyle='#fff';c.beginPath();c.moveTo(954,719);c.quadraticCurveTo(958,700,977,699);c.quadraticCurveTo(1003,694,1011,712);c.quadraticCurveTo(1021,735,1013,777);c.lineTo(994,802);c.lineTo(955,785);c.closePath();c.fill();
   c.restore();
   // The upper outside rim was also hidden. A continuous yellow sole cap
   // joins the original sole; it is not a stroke across the white upper.
   c.save();c.beginPath();c.moveTo(993,701);c.quadraticCurveTo(1007,700,1012,715);c.quadraticCurveTo(1018,735,1015,749);c.lineTo(1004,740);c.quadraticCurveTo(1007,714,993,711);c.closePath();c.fillStyle='#f9dc02';c.fill();c.restore();
  }
  patchData[id]={im,x,y};
 }
 const fill=(points,color)=>{ctx.fillStyle=color;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.fill();};
 const withPart=(s,id,fn)=>{const t=s.parts[id];ctx.save();ctx.translate(...t.pos);ctx.rotate(t.rotation*Math.PI/180);ctx.translate(-part[id].pivot[0],-part[id].pivot[1]);fn();ctx.restore();};
 const patch=(s,id,bone=id)=>{ctx.save();if(id.endsWith('-head'))ctx.translate(...neckPoints(s,id[0]).offset);withPart(s,bone,()=>{const p=patchData[id];ctx.drawImage(p.im,p.x,p.y);});ctx.restore();};
 const stroke=(points,width,color)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();};
 function leg(s,prefix,layer='all'){
  const h=s.parts[prefix+'-thigh'].pos,k=s.parts[prefix+'-shin'].pos,a=s.parts[prefix+'-shoe'].pos;
  const before=lerp(h,k,.7),after=lerp(k,a,.3),centres=[];
  for(let i=0;i<5;i++)centres.push(lerp(h,before,i/5));
  for(let i=0;i<=12;i++){const t=i/12;centres.push(add(add(mul(before,(1-t)**2),mul(k,2*t*(1-t))),mul(after,t*t)));}
  for(let i=1;i<=5;i++)centres.push(lerp(after,a,i/5));
  const left=[],right=[];
  for(let i=0;i<centres.length;i++){const d=unit(sub(centres[Math.min(i+1,centres.length-1)],centres[Math.max(i-1,0)])),n=[-d[1],d[0]],w=36-8*i/(centres.length-1);left.push(add(centres[i],mul(n,w)));right.push(add(centres[i],mul(n,-w)));}
  const color=prefix[0]==='g'?PALETTE.yellow:PALETTE.purple;
  // Ankle underlap prevents a transparent slit between the cuff and shoe.
  const foot=add(a,mul(unit(sub(a,k)),18));if(layer!=='front-foot')stroke([a,foot],25,PALETTE.skin);
  if(layer!=='rear'||prefix!=='g-front')patch(s,prefix+'-shoe');
  ctx.save();if(layer==='front-foot')ctx.globalCompositeOperation='destination-out';
  fill([...left,...right.reverse()],color);ctx.restore();
  if(layer==='front-foot')return;
  if(prefix.endsWith('front')){
   ctx.save();ctx.globalAlpha=.28;stroke(centres.slice(4,15).map((q,i)=>lerp(q,left[i+4],.57)),1.6,prefix[0]==='g'?'#9d8118':'#7954a0');ctx.restore();
  }
 }
 function pelvis(s,who){
  // A complete yoke joins BOTH leg roots to the waist. An ellipse around the
  // hip centre does not cover the diagonal gaps opened by rotating thighs.
  const waist=who==='g'?[[730,550],[798,543]]:[[1022,548],[1096,526]];
  const points=waist.map(q=>mapped(s,who+'-pelvis',q));
  for(const side of ['front','back']){
   const h=s.parts[who+'-'+side+'-thigh'].pos,k=s.parts[who+'-'+side+'-shin'].pos,d=unit(sub(k,h)),n=[-d[1],d[0]];
   for(const along of [-8,25])for(const across of [-36,36])points.push(add(add(h,mul(d,along)),mul(n,across)));
  }
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const lo=[],hi=[];
  for(const q of points){while(lo.length>1&&cross(lo.at(-2),lo.at(-1),q)<=0)lo.pop();lo.push(q);}
  for(const q of [...points].reverse()){while(hi.length>1&&cross(hi.at(-2),hi.at(-1),q)<=0)hi.pop();hi.push(q);}
  fill([...lo.slice(0,-1),...hi.slice(0,-1)],who==='g'?PALETTE.yellow:PALETTE.purple);
 }
 function sleeve(s,arm,sourceCuff,color,rootWidth,cuffWidth){
  const a=s.parts[arm].pos,b=mapped(s,arm,sourceCuff),d=unit(sub(b,a)),n=[-d[1],d[0]];
  // Sleeve roots remain in torso space; only cuffs follow the humerus.
  // This removes the rotating square root that used to stick out as a spike.
  const turn=s.shoulderTurn||0;
  const roots={'g-front-arm':[[737,487],[750,521]],'g-held-upper':[[773,487],[784,528]],'b-held-upper':[[1001,454],[1023,507]],'b-free-arm':[lerp([1023,435],[1011,479],turn),lerp([1061,482],[1034,514],turn)]}[arm].map(q=>mapped(s,arm[0]+'-body',q));
  const inside={'g-front-arm':[741,500],'g-held-upper':[780,510],'b-held-upper':[1010,490],'b-free-arm':lerp([1034,464],[1020,497],turn)}[arm];
  const c=mapped(s,arm[0]+'-body',inside),points=[...roots,add(b,mul(n,cuffWidth)),add(b,mul(n,-cuffWidth))];
  for(const centre of [a,c])for(let i=0;i<12;i++)points.push(add(centre,rot([14,0],i*30)));
  // One rounded envelope, not two crossing Beziers whose side assignment
  // flips during the downward sweep. Its roots and cuff are always joined.
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const lo=[],hi=[];
  for(const q of points){while(lo.length>1&&cross(lo.at(-2),lo.at(-1),q)<=0)lo.pop();lo.push(q);}
  for(const q of [...points].reverse()){while(hi.length>1&&cross(hi.at(-2),hi.at(-1),q)<=0)hi.pop();hi.push(q);}
  const ring=[...lo.slice(0,-1),...hi.slice(0,-1)];ctx.fillStyle=color;ctx.beginPath();
  for(let i=0;i<ring.length;i++){const q=ring[i],prev=ring[(i+ring.length-1)%ring.length],next=ring[(i+1)%ring.length],before=lerp(q,prev,Math.min(.2,4/Math.max(1,Math.hypot(...sub(prev,q))))),after=lerp(q,next,Math.min(.2,4/Math.max(1,Math.hypot(...sub(next,q)))));if(i===0)ctx.moveTo(...before);else ctx.lineTo(...before);ctx.quadraticCurveTo(...q,...after);}ctx.closePath();ctx.fill();
 }
 function body(s,who){withPart(s,who+'-body',()=>{
  ctx.fillStyle=who==='g'?PALETTE.coral:PALETTE.green;ctx.beginPath();
  if(who==='g'){
   ctx.moveTo(734,477);ctx.quadraticCurveTo(755,471,778,480);ctx.quadraticCurveTo(796,493,795,520);ctx.quadraticCurveTo(799,539,810,556);ctx.quadraticCurveTo(771,552,732,570);ctx.quadraticCurveTo(721,540,721,515);ctx.quadraticCurveTo(720,490,734,477);
  }else{
   ctx.moveTo(990,457);ctx.quadraticCurveTo(1006,447,1022,441);ctx.quadraticCurveTo(1042,438,1049,460);ctx.quadraticCurveTo(1073,493,1104,530);ctx.lineTo(1027,574);ctx.quadraticCurveTo(1010,537,998,505);ctx.quadraticCurveTo(983,475,990,457);
  }ctx.closePath();ctx.fill();
 });}
 return {render(s,figure=false,layer='all'){
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.save();if(figure){ctx.translate(900,600);ctx.scale(2.1,2.1);}else{ctx.translate(s.root.x,s.root.y);ctx.rotate(s.root.rotation*Math.PI/180);}ctx.translate(-900,-600);
  // Complete garments overlap at hidden joints; no missing source pixels.
  if(layer==='front-foot'){leg(s,'g-front',layer);ctx.restore();return;}
  leg(s,'g-back');leg(s,'g-front',layer);pelvis(s,'g');
  leg(s,'b-back');leg(s,'b-front');pelvis(s,'b');
  stroke([s.parts['g-front-arm'].pos,mapped(s,'g-front-arm',[635,500])],31,PALETTE.skin);
  patch(s,'g-front-hand','g-front-arm');
  stroke([mapped(s,'g-held-upper',[811,516]),s.parts['g-held-lower'].pos,s.hand],29,PALETTE.skin);
  stroke([mapped(s,'b-held-upper',[966,526]),s.parts['b-held-lower'].pos,s.hand],30,PALETTE.skin);
  sleeve(s,'g-front-arm',[692,500],PALETTE.coral,24,23);
  sleeve(s,'g-held-upper',[813,517],PALETTE.coral,23,21);
  sleeve(s,'b-held-upper',[964,529],PALETTE.green,27,25);
  for(const who of ['g','b']){const neck=neckPoints(s,who);stroke([neck.collar,neck.jaw],22,PALETTE.skin);}
  body(s,'g');body(s,'b');
  // The head mask has a diagonal bottom edge. Join the full collar width
  // underneath it: a narrow skin centreline alone leaves a background notch
  // between the chin and the forward shoulder despite passing alpha probes.
  const neck=neckPoints(s,'b');
  fill([add(mapped(s,'b-head',[988,442]),neck.offset),add(mapped(s,'b-head',[1024,420]),neck.offset),mapped(s,'b-body',[1030,476]),mapped(s,'b-body',[993,477])],PALETTE.green);
  // The free arm is the camera-facing arm in the supplied paired poses.
  // Draw the complete sleeve/arm/hand in front of the shirt, not behind it.
  stroke([mapped(s,'b-free-arm',[1097,453]),s.parts['b-free-forearm'].pos,mapped(s,'b-free-forearm',[1190,445])],30,PALETTE.skin);
  sleeve(s,'b-free-arm',[1099,453],PALETTE.green,26,25);
  patch(s,'b-free-hand','b-free-forearm');
  patch(s,'g-head');patch(s,'b-head');patch(s,'joined-hands');
  ctx.restore();
 }};
}
