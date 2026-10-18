export const ART_MOTION: Record<string, number[][]>;
export const HEAD_LOCKS: Record<string, number[][]>;
export function headLocks(id: string, part?: string): number[][];
export const MAX_ZONES: number;
export function motionZones(id: string, part?: string): number[][];
export function zoneAngle(zone: number[], time: number): number;
export function deformPoint(x: number, y: number, zones: number[][], time: number, heads?: number[][]): number[];
export const vertexShader: string;
export const fragmentShader: string;
