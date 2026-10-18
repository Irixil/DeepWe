import type { Pose } from "./motion.mjs";
export function isShoeOccluder(r: number,g: number,b: number): boolean;
export function createCompleteRig(canvas: HTMLCanvasElement, texture: HTMLImageElement): { render(pose: Pose, figure?: boolean, layer?: 'all' | 'rear' | 'front-foot'): void };
