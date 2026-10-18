export const LAUNCH_START: number;
export const FLIGHT_END: number;
export const GIRL_SUPPORT: number[];
export const DECK_SUPPORT: number[];
export function stagePhase(scroll: number, reduced?: boolean): { flight: number; detached: number };
export function boatBob(elapsedMs: number): number;
export function stagePlacement(width: number, height: number, boat: {x: number; y: number; width: number; height: number}): {scale: number; x: number; y: number; deck: number[]};
