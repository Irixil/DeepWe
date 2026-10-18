// One immutable texture; rigid articulated parts. No image swaps or scale tracks.
// Artwork coordinates stay in the original 1800 × 1200 image coordinate system.
export const W=1800,H=1200,DURATION=3.8;
export const FEMALE_LEG_LENGTHS={thigh:96,shin:99};
const R=Math.PI/180;
export const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const mix=(a,b,t)=>a+(b-a)*t;
const add=(a,b)=>[a[0]+b[0],a[1]+b[1]];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
export const rot=(p,a)=>[p[0]*Math.cos(a*R)-p[1]*Math.sin(a*R),p[0]*Math.sin(a*R)+p[1]*Math.cos(a*R)];
const len=p=>Math.hypot(...p),angle=p=>Math.atan2(p[1],p[0])/R;
const smooth=(a,b,p)=>{const t=clamp((p-a)/(b-a));return t*t*(3-2*t);};
const parts=[];
function part(id,pivot,poly,z,cap=null){parts.push({id,pivot,poly,z,cap});}
// Masks are runtime clipping paths, not repainted or independently generated PNGs.
part('g-back-thigh',[785,590],[[779,578],[823,607],[882,650],[884,676],[860,695],[816,659],[777,621]],10);
part('g-back-shin',[867,671],[[852,643],[979,687],[948,754],[921,748],[841,696]],11);
part('g-back-shoe',[960,720],[[969,699],[983,720],[978,751],[1004,772],[1018,794],[1009,827],[977,827],[949,801],[944,738]],12);
part('b-back-thigh',[1080,578],[[1050,559],[1105,558],[1148,613],[1142,653],[1109,675],[1076,659],[1050,616]],14);
part('b-back-shin',[1120,635],[[1097,627],[1148,546],[1170,545],[1204,590],[1167,637],[1127,669]],15);
part('b-back-shoe',[1181,572],[[1168,549],[1166,524],[1190,506],[1254,548],[1270,609],[1216,617],[1192,598]],16);
part('g-pelvis',[777,566],[[731,550],[793,546],[808,569],[791,590],[743,603],[730,589]],20);
part('g-front-thigh',[757,589],[[747,564],[776,585],[781,613],[760,636],[702,646],[645,624],[638,598],[674,575]],22);
part('g-front-shin',[684,614],[[653,594],[694,598],[773,650],[773,672],[717,710],[681,675],[650,642]],23);
part('g-front-shoe',[746,683],[[734,667],[770,670],[810,697],[812,772],[711,791],[699,742],[716,701]],24);
part('b-pelvis',[1061,559],[[1031,552],[1094,534],[1114,576],[1079,598],[1038,606]],26);
part('b-front-thigh',[1061,580],[[1032,562],[1080,590],[1060,644],[1025,687],[981,686],[971,651],[993,608]],27);
part('b-front-shin',[1016,657],[[994,637],[1049,648],[1108,711],[1100,744],[1063,778],[1009,718],[976,679]],28);
part('b-front-shoe',[1080,732],[[1095,718],[1145,733],[1150,840],[1054,850],[1050,793],[1066,760]],29);
part('g-front-arm',[728,489],[[537,442],[691,442],[697,526],[535,541]],31);
part('b-free-arm',[1047,448],[[1099,393],[1283,393],[1283,484],[1099,484]],32);
part('b-free-forearm',[1140,451],[],32.1);
part('g-held-upper',[786,499],[[813,501],[877,541],[864,575],[798,534]],33);
part('g-held-lower',[865,553],[[855,537],[905,554],[930,580],[916,606],[882,586],[848,566]],34);
part('b-held-upper',[1001,478],[[949,510],[983,528],[956,576],[924,557]],35);
part('b-held-lower',[938,560],[[925,545],[959,561],[939,595],[914,612],[884,584],[906,561]],36);
part('g-front-sleeve',[728,489],[[689,477],[727,475],[743,496],[724,521],[695,526]],37);
part('g-held-sleeve',[786,499],[[791,477],[829,503],[805,534],[784,516]],38);
part('b-free-sleeve',[1047,448],[[1045,429],[1102,429],[1103,479],[1050,473]],38.2);
part('b-held-sleeve',[1001,478],[[990,457],[1013,504],[981,542],[945,519],[970,462]],38.4);
part('g-body',[777,566],[[727,475],[739,461],[771,473],[793,477],[798,500],[794,523],[817,559],[791,570],[730,575],[716,538],[724,521],[743,496]],40);
part('b-body',[1061,559],[[982,429],[1036,428],[1058,472],[1076,479],[1111,529],[1063,562],[1024,583],[996,523],[1013,504],[990,457]],41);
part('g-head',[733,466],[[670,329],[911,329],[911,487],[812,488],[791,477],[749,477],[733,466],[719,475],[675,455]],44);
part('b-head',[995,437],[[941,328],[1073,328],[1075,425],[1013,429],[997,445],[984,445],[975,429],[947,420]],45);
part('joined-hands',[914,584],[[901,558],[927,554],[944,571],[947,594],[930,615],[905,619],[881,589],[888,568]],48);
export const PARTS=parts.sort((a,b)=>a.z-b.z);
export const SLEEVE_BINDINGS={'g-front-sleeve':'g-front-arm','g-held-sleeve':'g-held-upper','b-free-sleeve':'b-free-arm','b-held-sleeve':'b-held-upper'};
// Underlapping joint sockets rotate with the rigid segment; never stretch.
export const CAPS={
 'g-front-shin':[25,'#fadd02'],'g-back-shin':[24,'#f9da01'],'g-pelvis':[27,'#f9da01'],
 'b-front-shin':[24,'#dbaffb'],'b-back-shin':[24,'#d7aaf9'],'b-pelvis':[24,'#d7aaf9'],
 'g-held-lower':[13,'#ffbe84'],'b-held-lower':[13,'#ffbe84'],
 'g-front-sleeve':[14,'#fe6e54'],'g-held-sleeve':[15,'#fe6d53'],
 'b-free-sleeve':[10,'#8ed057'],'b-held-sleeve':[18,'#8ecf58'],
};

// A stable two-bone solve: no bone scaling, and both hands share ONE target.
function ik(a,target,L1,L2,side,soft=0){
 const v=sub(target,a),limit=L1+L2-.001,raw=len(v);
 const eased=soft>0&&raw>limit-soft?limit-soft*Math.exp(-(raw-(limit-soft))/soft):raw;
 const d=Math.max(.001,Math.min(eased,limit));
 const base=angle(v),c=clamp((L1*L1+d*d-L2*L2)/(2*L1*d),-1,1);
 const first=base+side*Math.acos(c)/R;
 const elbow=add(a,rot([L1,0],first));
 const solvedTarget=add(a,rot([d,0],base));
 return {elbow,first,second:angle(sub(solvedTarget,elbow))};
}
// The grip belongs to both characters. Project it into the intersection of
// their reach circles exactly; a few alternating clamps leave the other arm
// slightly stretched when the raised shoulders approach full extension.
function sharedGrip(a,b,ra,rb,target){
 const inside=(p,c,r)=>len(sub(p,c))<=r+1e-8;
 if(inside(target,a,ra)&&inside(target,b,rb))return target;
 const project=(c,r)=>{const v=sub(target,c);return add(c,v.map(x=>x*r/len(v)));};
 const pa=project(a,ra),pb=project(b,rb),candidates=[];
 if(inside(pa,b,rb))candidates.push(pa);
 if(inside(pb,a,ra))candidates.push(pb);
 const v=sub(b,a),d=len(v),u=v.map(x=>x/d),along=(ra*ra-rb*rb+d*d)/(2*d);
 const h=Math.sqrt(Math.max(0,ra*ra-along*along)),centre=add(a,u.map(x=>x*along));
 candidates.push(add(centre,[-u[1]*h,u[0]*h]),add(centre,[u[1]*h,-u[0]*h]));
 return candidates.sort((x,y)=>len(sub(x,target))-len(sub(y,target)))[0];
}
export function sample(p,referenceTrial=false,complete=false){
 p=clamp(p);
 // Raise the entire male rig during the forward lean, not just its head or
 // shoulder. The initial take-off remains registered to the approved image.
 const maleLift=complete?60*smooth(.12,.62,p):0;
 const out={},gHip=[777,566],bHip=[1061+(complete?37:referenceTrial?5:-30)*smooth(.12,.66,p),559+(complete?10:-90)*smooth(.13,.7,p)-maleLift];
 const gPitch=-54*smooth(.12,.64,p),bPitch=-50*smooth(.23,.72,p);
 const set=(id,pos,rotation=0)=>out[id]={pos,rotation};
 const transformed=(q,h,original,a)=>add(h,rot(sub(q,original),a));
 set('g-body',gHip,gPitch);set('g-pelvis',gHip,gPitch);
 set('b-body',bHip,bPitch);set('b-pelvis',bHip,bPitch);
 // Registration is constant in body space: connect the unchanged head texture
 // to the reconstructed collar; never compensate with time-varying scale.
 set('g-head',transformed([733,466],gHip,[777,566],gPitch),complete?gPitch*.55:gPitch);
 set('b-head',transformed([995,437],bHip,[1061,559],bPitch),complete?bPitch*.55:bPitch);
 const gs=transformed([728,489],gHip,[777,566],gPitch);
 set('g-front-arm',gs,complete?-9*smooth(.16,.56,p):gPitch*.35-7*smooth(.3,.7,p));
 // Reference video: lower the free arm beside the torso, then reach forward.
 const shoulderTurn=complete?smooth(.2,.66,p):0;
 const bs=transformed([1047-39*shoulderTurn,448+62*shoulderTurn],bHip,[1061,559],bPitch);
 const reach=smooth(.19,.65,p),fold=Math.sin(Math.PI*smooth(.19,.65,p));
 // Keep the elbow on its original bending side throughout the sweep.
 const upper=164*reach+bPitch*.18,lower=upper-28*fold+2*reach;
 set('b-free-arm',bs,upper);
 set('b-free-forearm',add(bs,rot([93,3],upper)),lower);
 const ga=transformed([786,499],gHip,[777,566],gPitch);
 const heldTurn=complete?smooth(.15,.62,p):0;
 const ba=transformed([1001+13*heldTurn,478+12*heldTurn],bHip,[1061,559],bPitch);
 const diff=sub(ba,ga),unit=[-diff[1]/len(diff),diff[0]/len(diff)];
 const originalDiff=[215,-21],originalGrip=[128,85];
 const originalQ=(originalDiff[0]*originalGrip[0]+originalDiff[1]*originalGrip[1])/(215*215+21*21);
 const originalH=(21*128+215*85)/Math.hypot(215,21);
 const gl1=len([79,54]),gl2=len([49,31]),bl1=len([-63,82]),bl2=len([-24,24]);
 // Keep the held arms softly extended, instead of pulling both elbows into a V.
 const d=len(diff),gr=gl1+gl2-1,br=bl1+bl2-1;
 const along=(gr*gr-br*br+d*d)/(2*d),height=Math.sqrt(Math.max(0,gr*gr-along*along));
 const u=smooth(.1,.72,p),q=mix(originalQ,along/d,u),h=mix(originalH,height,u);
 let hand=add(add(ga,[diff[0]*q,diff[1]*q]),[unit[0]*h,unit[1]*h]);
 if(complete){const t=smooth(.12,.57,p),direction=mix(angle([128,85]),12,t),distance=mix(len([128,85]),gl1+gl2-1,t);hand=add(ga,rot([distance,0],direction));}
 if(complete)hand=sharedGrip(ga,ba,gl1+gl2-.01,bl1+bl2-.01,hand);
 else for(let i=0;i<8;i++)for(const [s,max] of [[ga,gl1+gl2-.01],[ba,bl1+bl2-.01]]){
  const v=sub(hand,s),d=len(v);if(d>max)hand=add(s,[v[0]*max/d,v[1]*max/d]);
 }
 // Preserve the exact first-frame grip registration.
 if(p===0)hand=[914,584];
 const gi=ik(ga,hand,gl1,gl2,1),bi=ik(ba,hand,bl1,bl2,-1);
 set('g-held-upper',ga,gi.first-angle([79,54]));
 set('g-held-lower',gi.elbow,gi.second-angle([49,31]));
 set('b-held-upper',ba,bi.first-angle([-63,82]));
 set('b-held-lower',bi.elbow,bi.second-angle([-24,24]));
 set('joined-hands',hand,-12*u);
 // Reference free hand passes down beside the waist, then approaches the
 // shared grip. Solve its elbow on one side rather than spinning a fixed angle.
 if(complete){
 // Rotate the humerus through the lower semicircle. Interpolating wrist
 // positions instead cuts across the shoulder and folds the elbow early.
 // The reference passes back-out (.28), down (.43), forward (.59).
 const swing=smooth(.16,.64,p);
 const finish=smooth(.43,.68,p);
 const humerus=154*swing+14*finish;
 const forearm=158*swing+14*finish;
 set('b-free-arm',bs,humerus);
 set('b-free-forearm',add(bs,rot([93,3],humerus)),forearm);
 }else if(referenceTrial){
 const restFree=transformed([1211,442],bHip,[1061,559],bPitch);
 // In the paired reference the free hand hangs below the shoulder, on the
 // visible side of the torso. Do not interpret "down" in rotating body space.
 const lowFree=complete?add(bs,rot([158,0],90+60*(.45*p+.55*p*p))):transformed([1120,590],bHip,[1061,559],bPitch);
 const down=smooth(.14,.38,p),forward=smooth(.3,.6,p);
 const lowTarget=restFree.map((v,i)=>mix(v,lowFree[i],down));
 const freeTarget=lowTarget.map((v,i)=>mix(v,hand[i]+(complete?(i===0?4:0):(i===0?17:-8)),forward));
 const fi=ik(bs,freeTarget,len([93,3]),len([71,-9]),1,complete?6*smooth(.1,.25,p):0);
 set('b-free-arm',bs,fi.first-angle([93,3]));
 set('b-free-forearm',fi.elbow,fi.second-angle([71,-9]));
 }
 // Sleeve and exposed upper arm are rigid children of the SAME humerus.
 // Changing the elbow angle cannot leave a sleeve stuck on the torso.
 for(const [sleeve,arm] of Object.entries(SLEEVE_BINDINGS))out[sleeve]={pos:[...out[arm].pos],rotation:out[arm].rotation};
 const limb=(prefix,hip0,knee0,ankle0,pelvis,pelvis0,thighDelta,shinDelta,shoeDelta)=>{
  const hip=add(pelvis,rot(sub(hip0,pelvis0),prefix[0]==='g'?gPitch:bPitch));
  let thigh=sub(knee0,hip0),shin=sub(ankle0,knee0);
  if(complete&&prefix[0]==='g'){
   thigh=thigh.map(v=>v*FEMALE_LEG_LENGTHS.thigh/len(thigh));
   shin=shin.map(v=>v*FEMALE_LEG_LENGTHS.shin/len(shin));
  }
  const knee=add(hip,rot(thigh,thighDelta));
  const ankle=add(knee,rot(shin,shinDelta));
  set(prefix+'-thigh',hip,thighDelta);set(prefix+'-shin',knee,shinDelta);set(prefix+'-shoe',ankle,shinDelta);
 };
 const leg=smooth(.27,referenceTrial||complete?.56:.68,p),trail=smooth(.2,.57,p);
 const girlOpen=complete?smooth(.2,.56,p):leg;
 limb('g-front',[757,589],[684,614],[746,683],gHip,[777,566],(complete?-147:referenceTrial?-147:-88)*girlOpen,(complete?-34:referenceTrial?-38:-40)*girlOpen,-38*girlOpen);
 // One monotone opening only. No added tuck-and-release / backward kick.
 limb('g-back',[785,590],[867,671],[960,720],gHip,[777,566],(complete?-34:-33)*trail,(complete?-40:-20)*trail,-20*trail);
 limb('b-front',[1061,580],[1016,657],[1080,732],bHip,[1061,559],(referenceTrial||complete?-75:-62)*leg,(referenceTrial||complete?-52:-45)*leg,-52*leg);
 limb('b-back',[1080,578],[1120,635],[1181,572],bHip,[1061,559],-25*trail,19*trail,-12*trail);
 const root={x:1120-738*p,y:570-132+132*((p-.26)/.26)**2,rotation:-60*(.45*p+.55*p*p)};
 return {p,parts:out,root,hand,shoulderTurn,maleLift,scale:1};
}
export function worldPoint(p,id,source,complete=false){const s=sample(p,false,complete),v=s.parts[id];return add([s.root.x,s.root.y],rot(sub(add(v.pos,rot(sub(source,PARTS.find(v=>v.id===id).pivot),v.rotation)),[900,600]),s.root.rotation));}
export const waterY=(x,p)=>900+22*Math.sin(x/158+1.7+p*.4)+9*Math.sin(x/89+2.5);
export function contact(id,point,complete=false){let prev=0;for(let p=.26;p<=1;p+=.001){const v=worldPoint(p,id,point,complete),d=v[1]-waterY(v[0],p);if(d>=0&&prev<0)return {p,x:v[0],y:waterY(v[0],p)};prev=d;}return null;}
export const CONTACTS=[contact('g-front-arm',[584,501]),contact('b-head',[980,406])];
export const COMPLETE_CONTACTS=[contact('g-front-arm',[566,518],true),contact('b-head',[980,406],true)];
