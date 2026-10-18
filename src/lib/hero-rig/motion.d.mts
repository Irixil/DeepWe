export const W: number;
export const H: number;
export type Pose = { root: { x: number; y: number; rotation: number }; parts: Record<string, { pos: number[]; rotation: number }>; hand: number[] };
export function sample(progress: number, referenceTrial?: boolean, complete?: boolean): Pose;
