import { FLOW_UNITS, flowHeight, liquidGeometry, riverSection } from './water-flow.mjs';

// Anchors and contact points are measured in the original artwork pixels.
// Neither pose placement nor visibility depends on the water reveal progress.
export const RIVER_POSES = [
  { id: 'listen', file: 'listen-v2.png', y: 1020, mobileY: 600, anchor: [540,710], size: [1254,1254], scale: .48, part: 'whole', foot: [770,1115] },
  { id: 'express', file: 'express-woman-v1.png', y: 1560, mobileY: 1540, anchor: [555,740], size: [1024,1536], scale: .5, part: 'whole' },
  { id: 'couple', file: 'couple-v2.png', y: 2330, mobileY: 2040, anchor: [450,577], size: [1536,1024], scale: .56, part: 'left', foot: [448,826] },
  { id: 'couple', file: 'couple-v2.png', y: 2330, mobileY: 2190, anchor: [1090,577], size: [1536,1024], scale: .56, part: 'right', foot: [1104,840] },
  { id: 'understand', file: 'understand-climb-v1.png', y: 3300, mobileY: 2880, anchor: [512,768], size: [1024,1536], scale: .52, part: 'whole' },
  { id: 'records', file: 'records-walk-v1.png', y: 4250, mobileY: 4110, anchor: [700,842], size: [1536,1024], scale: .48, part: 'whole' },
];

export function riverPoseLayout(pose, width, height) {
  const mobile = width <= 900, sx = width / 1600, sy = flowHeight(width) / FLOW_UNITS;
  const unitY = mobile ? pose.mobileY : pose.y;
  const section = riverSection(unitY, mobile);
  let axis = section.center;
  if (pose.id === 'couple') axis = pose.part === 'left'
    ? (section.left + section.center - section.gap) / 2 + 12
    : (section.right + section.center + section.gap) / 2 - 12;
  if (pose.id === 'express') axis = section.right - 20;
  if (pose.id === 'records') axis = section.right + 30;
  const mobileScale = pose.id === 'listen' ? 1.4 : ['understand','express'].includes(pose.id) ? 1.5 : pose.id === 'records' ? 2.0 : 1.1;
  const scale = pose.scale * sx * (mobile ? mobileScale : 1);
  let x = axis * sx;
  // Mobile presents full artwork above its card instead of squeezing it behind copy.
  if (mobile && pose.id === 'listen') x = width * .16;
  if (mobile && pose.id === 'express') x = width * .67;
  if (mobile && pose.id === 'understand') x = width * .51;
  if (mobile && pose.id === 'records') x = width * .47;
  if (mobile && pose.id === 'couple' && pose.part === 'right') x -= 15 * sx;
  const y = liquidGeometry(width, height).origin + unitY * sy;
  const left = x - pose.anchor[0] * scale, top = y - pose.anchor[1] * scale;
  return { x, y, left, top, scale, unitY,
    foot: pose.foot ? { x: left + pose.foot[0] * scale, y: top + pose.foot[1] * scale, rx: (pose.id === 'listen' ? 122 : 105) * scale, ry: 22 * scale } : null };
}
