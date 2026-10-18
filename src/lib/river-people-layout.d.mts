export type RiverPose = {
  id: string; file: string; y: number; mobileY: number; anchor: number[];
  size: number[]; scale: number; part: string; foot?: number[];
};
export const RIVER_POSES: RiverPose[];
export function riverPoseLayout(pose: RiverPose, width: number, height: number): {
  x: number; y: number; left: number; top: number; scale: number; unitY: number;
  foot: { x: number; y: number; rx: number; ry: number } | null;
};
