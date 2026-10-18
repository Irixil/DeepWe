// One filled water surface, including the opening sea and both banks.
// Text shares its moving parent. Only the reveal mask has a moving tip.
export const FLOW_UNITS = 4600;
export const SCENE_POSITIONS = [950, 2200, 3300, 4250];
export const flowHeight = width => width <= 900 ? 3600 : Math.max(3600, width * 2.65);
// Remove only the quiet sea lead-in. The downstream banks and bend lengths
// remain the accepted geometry; the story starts earlier by the same amount.
export const seaLeadInTrim = height => height * .48;
const clamp = v => Math.max(0, Math.min(1, v));
const blend = v => { const t=clamp(v); return t*t*t*(t*(t*6-15)+10); };
const mix = (a,b,t) => a+(b-a)*t;
function interpolate(knots,y) {
  if(y<=knots[0][0])return knots[0][1];
  for(let i=1;i<knots.length;i++)if(y<=knots[i][0]){
    const [a,x]=knots[i-1],[b,z]=knots[i];return mix(x,z,blend((y-a)/(b-a)));
  }
  return knots.at(-1)[1];
}
export function riverSection(y, mobile=false) {
  const solo=mobile?170:430,join=mobile?1280:1060,end=mobile?1350:1100;
  const center=interpolate(mobile?[[950,solo],[1780,1320],[2180,1360],[2630,1320],[3300,solo],[4250,end],[4700,950]]:[[950,solo],[2170,join],[3300,solo],[4250,end],[4700,950]],y);
  const swell=y>1500&&y<2900?Math.sin(Math.PI*(y-1500)/1400)**2:0;
  const radius=110+(mobile?90:190)*swell;
  const gap=y>1810&&y<2550?(mobile?80:145)*Math.sqrt(1-((y-2180)/370)**2):0;
  return {left:center-radius,right:center+radius,center,gap};
}
function banks(y,mobile,pull) {
  if(y>=950)return riverSection(y,mobile);
  const solo=mobile?170:430;
  // Right bank is drawn down first: no symmetrical funnel or straight neck.
  const left=interpolate([[-650,-180],[-300,-180],[300,-60],[950,solo-110]],y);
  const right=interpolate([[-650,1780],[-300,1780],[150,1350],[550,solo+340],[950,solo+110]],y);
  const swelling=(1-pull)*Math.sin(Math.PI*clamp((y+300)/1250))*260;
  return {left:left-swelling,right:right+swelling,center:(left+right)/2,gap:0};
}
const n=v=>Math.round(v*100)/100;
function curve(points) {
  return points.slice(1).map((p,i)=>{
    const a=points[i],prev=points[Math.max(0,i-1)],next=points[Math.min(points.length-1,i+2)];
    return `C${n(a[0]+(p[0]-prev[0])/6)} ${n(a[1]+(p[1]-prev[1])/6)} ${n(p[0]-(next[0]-a[0])/6)} ${n(p[1]-(next[1]-a[1])/6)} ${n(p[0])} ${n(p[1])}`;
  }).join(' ');
}
export function liquidGeometry(width,height,pull=1) {
  const mobile=width<=900,scale=width/1600,flow=flowHeight(width),sy=flow/FLOW_UNITS;
  const origin=1.96*height-seaLeadInTrim(height);
  const pos=(x,y)=>[x*scale,origin+y*sy];
  const points=[-180,106,396,684,974,1252,1534,1780],lifts=[68,52,82,58,90,62,76];
  const surface=height*.955;
  let d=`M${points[0]*scale} ${surface}`;
  points.slice(1).forEach((end,i)=>{const start=points[i],w=end-start;d+=` C${(start+w*.27)*scale} ${surface-lifts[i]*height/1000} ${(start+w*.73)*scale} ${surface-lifts[i]*height/1000} ${end*scale} ${surface}`;});
  const ys=Array.from({length:211},(_,i)=>-650+i*25);
  const right=ys.map(y=>pos(banks(y,mobile,pull).right,y)),left=ys.map(y=>pos(banks(y,mobile,pull).left,y)).reverse();
  d+=` L${right[0].map(n).join(' ')} ${curve(right)} L${left[0].map(n).join(' ')} ${curve(left)} Z`;
  // One closed aperture. There are no overlapping strokes at either junction.
  const hole=Array.from({length:97},(_,i)=>{const a=i*Math.PI/48,y=2180+370*Math.sin(a);return pos(riverSection(y,mobile).center+(mobile?80:145)*Math.cos(a),y);});
  d+=` M${hole[0].map(n).join(' ')} ${curve(hole)} Z`;
  return {d,origin,height:origin+flow,flow};
}
export function liquidReveal(progress,width,height) {
  const flow=flowHeight(width),sy=flow/FLOW_UNITS,origin=height*1.96-seaLeadInTrim(height);
  // Never round-clip the broad sea into a bowl. The growth front begins only
  // after the neck; it meets each bank exactly at the cap's diameter.
  const reach=Math.max(950*sy,Math.min(flow+140,progress*(flow+height*.5)-height*.45));
  const y=reach/sy,s=banks(y,width<=900,1),sx=width/1600;
  const tip=origin+reach;
  const spansAt=value=>{const q=banks(value,width<=900,1);return s.gap>0?[[q.left,q.center-q.gap],[q.center+q.gap,q.right]]:[[q.left,q.right]];};
  const spans=spansAt(y),before=spansAt(y-.2),after=spansAt(y+.2);
  const caps=spans.map(([a,b],i)=>{
    const l=a*sx,r=b*sx,radius=(r-l)/2,x=(r+l)/2;
    const dl=(after[i][0]-before[i][0])/.4*sx/sy,dr=(after[i][1]-before[i][1])/.4*sx/sy;
    const k=radius*.55,tipX=x+(dl+dr)*radius*.3;
    // At both attachments the cap's derivative equals the bank's derivative.
    // A circular mask intersects a sloping bank; this cap follows it instead.
    const d=`M${n(r)} ${n(tip)} C${n(r+dr*k)} ${n(tip+k)} ${n(tipX+radius*.55)} ${n(tip+radius)} ${n(tipX)} ${n(tip+radius)} C${n(tipX-radius*.55)} ${n(tip+radius)} ${n(l+dl*k)} ${n(tip+k)} ${n(l)} ${n(tip)} L${n(l)} ${n(tip-2)} L${n(r)} ${n(tip-2)} Z`;
    return {x,y:tip,r:radius,d};
  });
  return {tip,flat:tip,caps};
}
