// Continuous, local illustration motion. The original texture is never sliced
// at a joint; head, torso, seat and planted sole remain at their approved anchor.
// zone: [cx, cy, radiusX, radiusY, pivotX, pivotY, radians, seconds, phase]
export const ART_MOTION = {
  listen: [
    [748, 439, 125, 148, 682, 550, .13, 5.8, 0],
    [911, 924, 147, 146, 795, 812, .07, 7.6, 1.2],
  ],
  express: [
    [172, 466, 212, 153, 299, 552, .12, 5.4, 0],
    [873, 575, 152, 174, 759, 675, -.14, 6.3, 1.4],
    [296, 986, 130, 193, 319, 868, .065, 8.1, .7],
  ],
  'couple-left': [
    [551, 413, 105, 119, 520, 486, .16, 6.5, .3],
    [651, 744, 122, 98, 580, 677, .08, 8.2, 1.8],
  ],
  'couple-right': [
    [967, 408, 105, 123, 988, 488, -.15, 6.5, 2.5],
    [948, 751, 116, 101, 997, 677, -.075, 8.6, .6],
  ],
  understand: [
    // Both palms and their single envelope share one continuous field.
    [486, 634, 149, 187, 446, 566, .14, 7.2, 0],
    [471, 216, 95, 115, 390, 294, .06, 8.4, 1.8],
    [172, 827, 94, 154, 195, 687, .065, 8.4, 1.8],
    [840, 1355, 108, 163, 792, 1218, -.055, 7.9, 2.1],
  ],
  records: [
    [708, 480, 76, 110, 643, 403, -.14, 5.8, 0],
    [1145, 404, 100, 125, 1115, 344, .16, 6.4, 1.1],
    [361, 767, 116, 158, 453, 635, -.045, 5.8, 0],
    [665, 817, 113, 143, 602, 678, .045, 5.8, 3.14],
    [819, 790, 106, 133, 889, 671, -.045, 6.4, 1.1],
    [1177, 801, 125, 145, 1068, 686, .045, 6.4, 4.24],
  ],
};

export const HEAD_LOCKS = {
  listen: [[606,264,146,140]], express: [[596,315,151,151]],
  'couple-left': [[447,270,100,105]], 'couple-right': [[1064,273,98,111]],
  understand: [[335,248,92,107],[755,752,110,114]],
  records: [[546,215,93,94],[989,199,96,99]],
};
export function headLocks(id,part='whole') { return HEAD_LOCKS[id==='couple'?id+'-'+part:id] || []; }
export const MAX_ZONES = 6;
export function motionZones(id, part = 'whole') {
  return ART_MOTION[id === 'couple' ? id + '-' + part : id] || [];
}
export function zoneAngle(zone, time) {
  if (time <= 0) return 0;
  // Ease away from the unmodified source; revisiting a section resumes its clock.
  const entrance = Math.min(1, Math.max(0, time) / 1.2);
  const ease = entrance * entrance * (3 - 2 * entrance);
  return zone[6] * Math.sin(time * Math.PI * 2 / zone[7] + zone[8]) * ease;
}
export function deformPoint(x, y, zones, time, heads = []) {
  let dx = 0, dy = 0;
  for (const zone of zones) {
    const [cx, cy, rx, ry, px, py] = zone;
    const distance = Math.hypot((x-cx)/rx, (y-cy)/ry);
    const t = Math.min(1, Math.max(0, (distance - .5) / .5));
    const weight = 1 - t*t*(3-2*t);
    const angle = zoneAngle(zone, time), c = Math.cos(angle), s = Math.sin(angle);
    dx += ((x-px)*c - (y-py)*s + px-x)*weight;
    dy += ((x-px)*s + (y-py)*c + py-y)*weight;
  }
  let unlocked = 1;
  for(const [cx,cy,rx,ry] of heads){
    const d = Math.hypot((x-cx)/rx,(y-cy)/ry);
    const t = Math.max(0,Math.min(1,(d-1)/.55));
    unlocked *= t*t*(3-2*t);
  }
  return [x+dx*unlocked, y+dy*unlocked];
}

export const vertexShader = `
attribute vec2 aPosition;
uniform vec2 uSize;
uniform vec4 uZone[6];
uniform vec3 uMotion[6];
uniform vec4 uHead[2];
varying vec2 vUV;
void main() {
  vec2 p = aPosition;
  vec2 delta = vec2(0.0);
  for (int i=0;i<6;i++) {
    vec4 z = uZone[i];
    float distance = length((p-z.xy)/max(z.zw,vec2(1.0)));
    float weight = 1.0-smoothstep(.5,1.0,distance);
    vec2 q = p-uMotion[i].xy;
    float c = cos(uMotion[i].z), s = sin(uMotion[i].z);
    delta += (vec2(q.x*c-q.y*s,q.x*s+q.y*c)-q)*weight;
  }
  float unlocked = 1.0;
  for(int j=0;j<2;j++) {
    float d = length((p-uHead[j].xy)/max(uHead[j].zw,vec2(1.0)));
    unlocked *= smoothstep(1.0,1.55,d);
  }
  delta *= unlocked;
  vUV = p/uSize;
  gl_Position = vec4((p.x+delta.x)/uSize.x*2.0-1.0,1.0-(p.y+delta.y)/uSize.y*2.0,0.0,1.0);
}`;
export const fragmentShader = `
precision mediump float;
uniform sampler2D uImage;
varying vec2 vUV;
void main() {
  vec4 color=texture2D(uImage,vUV);
  float keyed=clamp(4.0*clamp(-3.0*color.r+6.0*color.g-3.0*color.b+3.0,0.0,1.0)-.5,0.0,1.0)*color.a;
  gl_FragColor=vec4(color.rgb*keyed,keyed);
}`;
