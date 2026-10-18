"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { FLOW_UNITS, flowHeight, liquidGeometry } from "@/lib/water-flow.mjs";
import { RIVER_POSES, riverPoseLayout, type RiverPose } from "@/lib/river-people-layout.mjs";
import { RiverArtCanvas } from "./river-art-canvas";
import art from "./river-people.module.css";

// Matte sources are not alpha cutouts. People use magenta so blue/green skin
// is never keyed away. Ocean plants/fish retain their existing blue key.
export function ArtworkKey({ id, matte = "blue" }: { id: string; matte?: "blue" | "magenta" }) {
  return <filter id={id} colorInterpolationFilters="sRGB" x="-2%" y="-2%" width="104%" height="104%">
    <feColorMatrix type="matrix" values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  ${matte === "magenta" ? "-3 6 -3 0 3" : "3 3 -3 0 .25"}`} />
    <feComponentTransfer><feFuncA type="linear" slope="4" intercept="-.5" /></feComponentTransfer>
    <feComposite in2="SourceAlpha" operator="in" />
  </filter>;
}

function useArtVisibility<T extends Element>(reduced: boolean | null) {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (reduced || !ref.current) return;
    let visible = false;
    const sync = () => setActive(visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(ref.current);
    document.addEventListener("visibilitychange", sync);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", sync); };
  }, [reduced]);
  return { ref, active };
}

export function OceanLife({ progress, reduced }: { progress: MotionValue<number>; reduced: boolean | null }) {
  const { ref, active } = useArtVisibility<HTMLDivElement>(reduced);
  const x = useTransform(progress, [0, .35], [12, -36]);
  const y = useTransform(progress, [0, .35], [0, 16]);
  return <div ref={ref} className={art.oceanLife} data-active={active} aria-hidden="true" data-testid="sea-life">
    <svg className={art.definitions}><defs><ArtworkKey id="ocean-art-key" /></defs></svg>
    <motion.svg className={art.nearFish} viewBox="0 0 1536 1024" style={reduced ? undefined : { x, y }}>
      <image className={art.swim} href="/brand/ocean-life/fish-school-v1.png" width="1536" height="1024" filter="url(#ocean-art-key)" />
    </motion.svg>
    <svg className={art.farFish} viewBox="0 0 1536 1024">
      <image className={art.swim} href="/brand/ocean-life/fish-school-v1.png" width="1536" height="1024" filter="url(#ocean-art-key)" />
    </svg>
    <svg className={art.kelp} viewBox="0 0 1024 1536">
      <image className={art.sway} href="/brand/ocean-life/kelp-v1.png" width="1024" height="1536" filter="url(#ocean-art-key)" />
    </svg>
    <svg className={`${art.bubbles} ${art.bubblesNear}`} viewBox="0 0 80 200"><circle cx="20" cy="168" r="11"/><circle cx="47" cy="109" r="7"/><circle cx="37" cy="65" r="4"/></svg>
    <svg className={`${art.bubbles} ${art.bubblesFar}`} viewBox="0 0 80 200"><circle cx="49" cy="167" r="8"/><circle cx="30" cy="117" r="4"/><circle cx="39" cy="79" r="3"/></svg>
  </div>;
}

function RiverPerson({ pose, width, height, reduced }: { pose: RiverPose; width: number; height: number; reduced: boolean | null }) {
  const { ref, active } = useArtVisibility<SVGGElement>(reduced);
  const [ready, setReady] = useState(false);
  const layout = riverPoseLayout(pose, width, height);
  // Node and the browser can differ at 1e-13 after curve interpolation.
  // Serialize geometry deterministically without changing the layout sampler.
  const pixel = (value: number) => Number(value.toFixed(6));
  const [x,y,left,top,scale] = [layout.x,layout.y,layout.left,layout.top,layout.scale].map(pixel);
  const foot = layout.foot && { x: pixel(layout.foot.x), y: pixel(layout.foot.y), rx: pixel(layout.foot.rx), ry: pixel(layout.foot.ry) };
  const id = pose.id + '-' + pose.part;
  const clipX = pose.part === 'right' ? 768 : 0;
  const clipWidth = pose.part === 'whole' ? pose.size[0] : 768;
  return <g ref={ref} data-art={id} data-active={active} data-ready={ready && !reduced} data-seat-x={x} data-seat-y={y} className={art.person}>
    <defs><clipPath id={id + '-source'}><rect x={clipX} y="0" width={clipWidth} height={pose.size[1]} /></clipPath></defs>
    {foot && <ellipse data-contact={id} cx={foot.x} cy={foot.y} rx={foot.rx} ry={foot.ry} className={art.contactRipple} />}
    <g transform={'translate(' + left + ' ' + top + ') scale(' + scale + ')'}>
      <image className={art.staticPerson} href={'/brand/river-people/' + pose.file} width={pose.size[0]} height={pose.size[1]} filter="url(#people-art-key)" clipPath={'url(#' + id + '-source)'} />
      <foreignObject className={art.livePerson} x={clipX} y={0} width={clipWidth} height={pose.size[1]} overflow="hidden">
        <div style={{ marginLeft: -clipX }}><RiverArtCanvas id={pose.id} part={pose.part} file={pose.file} width={pose.size[0]} height={pose.size[1]} scale={scale} active={active} reduced={reduced} onReady={setReady} /></div>
      </foreignObject>
    </g>
    {foot && <path className={art.contactRipple} data-contact-front={id} d={'M' + (foot.x-foot.rx) + ' ' + foot.y + ' A' + foot.rx + ' ' + foot.ry + ' 0 0 0 ' + (foot.x+foot.rx) + ' ' + foot.y} />}
  </g>;
}

// Props belong to the chapter, not the moving tip of the water. The atlas is
// clipped only between separate objects; no human joints or silhouettes are cut.
const PROPS = [
  { kind: 0, x: 175, y: 640, size: 190, turn: -18 },
  { kind: 1, x: 710, y: 690, size: 150, turn: 202 },
  { kind: 4, x: 1250, mobileX: 330, y: 1440, size: 140, turn: 14 },
  { kind: 3, x: 175, y: 1540, size: 205, turn: -22 },
  { kind: 5, x: 1475, mobileX: 300, y: 1830, size: 155, turn: 18 },
  { kind: 7, x: 760, y: 2420, size: 130, turn: -12 },
  { kind: 1, x: 1320, y: 2650, size: 200, turn: 188 },
  { kind: 4, x: 850, y: 2880, size: 135, turn: -18 },
  { kind: 1, x: 100, y: 3210, size: 145, turn: 214 },
  { kind: 0, x: 830, y: 3590, size: 155, turn: -22 },
  { kind: 3, x: 170, y: 3710, size: 225, turn: -5 },
  { kind: 2, x: 800, y: 3940, size: 180, turn: 8 },
  { kind: 6, x: 1460, y: 3820, size: 165, turn: -8 },
  { kind: 3, x: 1450, y: 4520, size: 200, turn: 4 },
];

function ChapterProp({ children, kind, reduced }: { children: ReactNode; kind: number; reduced: boolean | null }) {
  const { ref, active } = useArtVisibility<SVGGElement>(reduced);
  const animation = kind === 1 ? art.planeMotion : kind === 3 ? art.leafMotion : art.paperMotion;
  return <g ref={ref} data-active={active} className={art.propActivity}><g className={animation}>{children}</g></g>;
}

function RiverProps({ width, height, reduced }: { width: number; height: number; reduced: boolean | null }) {
  const mobile = width <= 900, sx = width / 1600, sy = flowHeight(width) / FLOW_UNITS;
  const origin = liquidGeometry(width, height).origin;
  return <g className={art.riverProps} data-testid="river-props">
    {PROPS.filter((_, i) => !mobile || [0,1,2,4,8,10,11,13].includes(i)).map((prop, i) => {
      const size = prop.size * sx * (mobile ? 1.4 : 1);
      const cell = 627, slot = prop.kind % 4, col = slot % 2, row = Math.floor(slot / 2);
      const propX = mobile && prop.mobileX !== undefined ? prop.mobileX : prop.x;
      const atlas = prop.kind < 4 ? 'story-props-v1.png' : 'story-details-v1.png';
      return <g key={i} transform={'translate(' + propX*sx + ' ' + (origin+prop.y*sy) + ') rotate(' + prop.turn + ')'} data-prop={prop.kind}>
        <ChapterProp kind={prop.kind} reduced={reduced}><svg x={-size/2} y={-size/2} width={size} height={size} viewBox={[col*cell,row*cell,cell,cell].join(' ')} overflow="hidden">
        <image href={'/brand/river-people/' + atlas} width="1254" height="1254" filter="url(#people-art-key)" />
        </svg></ChapterProp>
      </g>;
    })}
    {!mobile && [[115,1080],[690,1550],[1435,2310],[180,2790],[785,3390],[980,4510]].map(([x,y],i) => <g key={i} transform={'translate(' + x*sx + ' ' + (origin+y*sy) + ') scale(' + sx + ')'}>
      <path d="M0 0 Q20 -15 30 5 T57 2" fill="none" stroke={i%2 ? '#8bcf58' : '#ff705f'} strokeWidth="6" strokeLinecap="round" />
      <ellipse cx="60" cy="48" rx="7" ry="16" transform="rotate(-30 60 48)" fill="#d8adf1" />
    </g>)}
  </g>;
}

export function RiverPeople({ width, height, reduced }: { width: number; height: number; reduced: boolean | null }) {
  const geometry = liquidGeometry(width, height);
  // Match the water's pixel canvas so scrollbars cannot move contact points.
  return <svg className={art.riverPeople} width={width} height={geometry.height} style={{ width, height: geometry.height }} viewBox={'0 0 ' + width + ' ' + geometry.height} aria-hidden="true" data-testid="river-people">
    <defs><ArtworkKey id="people-art-key" matte="magenta" /></defs>
    <RiverProps width={width} height={height} reduced={reduced} />
    {RIVER_POSES.map(pose => <RiverPerson key={pose.id + '-' + pose.part} pose={pose} width={width} height={height} reduced={reduced} />)}
  </svg>;
}
