// One registration and one bob clock for boat + passengers. Art coordinates
// are unchanged; the front gunwale is the physical occluder while on board.
export const LAUNCH_START = 0.045;
export const FLIGHT_END = 0.62;
// Opaque sole tip (988,815), transformed through the approved initial rig.
export const GIRL_SUPPORT = [1188.8838873831796, 768.6122338313478];
export const DECK_SUPPORT = [790 / 1536, 757 / 1024];
const clamp = x => Math.max(0, Math.min(1, x));
export function stagePhase(scroll, reduced = false) {
  const flight = reduced ? 0 : clamp((scroll - LAUNCH_START) / (FLIGHT_END - LAUNCH_START));
  const t = clamp(flight / 0.14);
  return { flight, detached: t * t * (3 - 2 * t) };
}
export function boatBob(elapsedMs) {
  return -2 + 5 * Math.cos(elapsedMs * 2 * Math.PI / 5800);
}
export function stagePlacement(width, height, boat) {
  const scale = Math.min(width / (width <= 900 ? 1300 : 2000), height / 1440);
  const deck = [boat.x + boat.width * DECK_SUPPORT[0], boat.y + boat.height * DECK_SUPPORT[1]];
  return { scale, x: deck[0] - GIRL_SUPPORT[0] * scale, y: deck[1] - GIRL_SUPPORT[1] * scale, deck };
}
