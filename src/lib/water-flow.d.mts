export const FLOW_UNITS: number;
export const SCENE_POSITIONS: number[];
export function flowHeight(width: number): number;
export function seaLeadInTrim(height: number): number;
export function riverSection(y: number, mobile?: boolean): {left:number;right:number;center:number;gap:number};
export function liquidGeometry(width:number,height:number,pull?:number): {d:string;origin:number;height:number;flow:number};
export function liquidReveal(progress:number,width:number,height:number): {tip:number;flat:number;caps:{x:number;y:number;r:number;d:string}[]};
