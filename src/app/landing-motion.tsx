"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { motion, useMotionValue, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import styles from "./landing-v2.module.css";
import { HeroCouple } from "./hero-couple";
import { OceanLife, RiverPeople } from "./river-people";
import { boatBob } from "@/lib/hero-rig/stage.mjs";
import { liquidGeometry, liquidReveal, SCENE_POSITIONS, FLOW_UNITS, flowHeight } from "@/lib/water-flow.mjs";

type SeaPhase = {
  surface: number;
  shoulder: number;
  neckRight: number;
  neckLeft: number;
  neckTop: number;
};

const SEA_PHASES: SeaPhase[] = [
  { surface: 920, shoulder: 1160, neckRight: 1780, neckLeft: -180, neckTop: 1110 },
  { surface: 650, shoulder: 1030, neckRight: 1510, neckLeft: 90, neckTop: 980 },
  { surface: 260, shoulder: 770, neckRight: 1140, neckLeft: 460, neckTop: 810 },
  { surface: -220, shoulder: 430, neckRight: 910, neckLeft: 690, neckTop: 650 },
];

type SeaLayer = "rear" | "middle" | "crest" | "front";

const WAVE_POINTS: Record<SeaLayer, number[]> = {
  rear: [-180, 92, 378, 648, 932, 1206, 1486, 1780],
  middle: [-180, 152, 448, 728, 1018, 1302, 1588, 1780],
  crest: [-180, 34, 286, 554, 842, 1116, 1392, 1638, 1780],
  front: [-180, 106, 396, 684, 974, 1252, 1534, 1780],
};
const WAVE_LIFTS: Record<SeaLayer, number[]> = {
  rear: [58, 86, 54, 78, 64, 88, 52],
  middle: [76, 50, 84, 58, 90, 56, 72],
  crest: [54, 80, 48, 86, 60, 74, 46, 66],
  front: [68, 52, 82, 58, 90, 62, 76],
};
const WAVE_OFFSETS: Record<SeaLayer, number> = {
  rear: -120,
  middle: -65,
  crest: -15,
  front: 35,
};

function makeSeaSurface(phase: SeaPhase, layer: SeaLayer) {
  const surface = phase.surface + WAVE_OFFSETS[layer];
  const phaseLift = phase.surface === SEA_PHASES[0].surface ? 1 : phase.surface === SEA_PHASES[1].surface ? 0.74 : 0.48;
  const points = WAVE_POINTS[layer];
  const segments = points.slice(1).map((end, index) => {
    const start = points[index];
    const width = end - start;
    const lift = WAVE_LIFTS[layer][index] * phaseLift;
    return `C${start + width * 0.27} ${surface - lift} ${start + width * 0.73} ${surface - lift} ${end} ${surface}`;
  });

  return [`M${points[0]} ${surface}`, ...segments].join("");
}

function makeWaveBody(phase: SeaPhase, layer: Exclude<SeaLayer, "front">) {
  return `${makeSeaSurface(phase, layer)}L1780 1080L-180 1080Z`;
}

const SEA_REAR_SHAPE = makeWaveBody(SEA_PHASES[0], "rear");
const SEA_MIDDLE_SHAPE = makeWaveBody(SEA_PHASES[0], "middle");
const SEA_CREST_SHAPE = makeWaveBody(SEA_PHASES[0], "crest");

const STORY_SCENES = [
  {
    id: "listen",
    label: "潜谈",
    title: "先把故事说完整。",
    body: "从一件具体的事开始。DeepWe 会陪你梳理发生了什么、你感受到了什么，以及真正放不下的是什么。",
    note: "这里的原始表达只对你可见。",
    action: "开始一次潜谈",
    href: "/app",
  },
  {
    id: "couple",
    label: "双人复盘",
    title: "两个人，都先被认真听见。",
    body: "你们不必同时开始，也不必马上面对面。每个人先在自己的私密空间表达，按自己的节奏完成。",
    note: "只有本人确认过的内容，才会走向共同区域。",
    action: "发起双人复盘",
    href: "/app/couple?tab=couple",
  },
  {
    id: "understand",
    label: "共同理解",
    title: "不急着判断谁对谁错。",
    body: "DeepWe 只把双方确认过的表达放在一起，帮助你们看见共同事实、不同感受、彼此需要和下一步。",
    note: "共同空间呈现两个视角，不是一份裁决。",
    action: "进入共同理解",
    href: "/app/couple?tab=couple",
  },
  {
    id: "records",
    label: "记录",
    title: "把真正的改变留下来。",
    body: "保留双方共同确认的理解、各自愿意尝试的行动，以及约定好的回望时间，让变化不被一次对话冲走。",
    note: "记录服务于回望，不用于给关系打分。",
    action: "查看共同记录",
    href: "/app/couple?tab=records",
  },
] as const;

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function useViewport() {
  const [size, setSize] = useState({width:1280,height:800});
  useEffect(() => {
    const update = () => setSize({width:window.innerWidth,height:window.innerHeight});
    update(); window.addEventListener('resize',update);
    return () => window.removeEventListener('resize',update);
  }, []);
  return size;
}

function OpeningBackWaves({ rideY, reduceMotion }: { rideY: MotionValue<string>; reduceMotion: boolean | null }) {
  return (
    <motion.svg className={`${styles.openingWater} ${styles.openingWaterBackLayer}`} viewBox="0 0 1600 1000" preserveAspectRatio="none" aria-hidden="true" style={reduceMotion ? undefined : { y: rideY }}>
      <path className={styles.openingWaterBack} d={SEA_REAR_SHAPE} />
      <path className={styles.openingWaterMiddle} d={SEA_MIDDLE_SHAPE} />
    </motion.svg>
  );
}

function OpeningCrestWave({ rideY, reduceMotion }: { rideY: MotionValue<string>; reduceMotion: boolean | null }) {
  return (
    <motion.svg className={`${styles.openingWater} ${styles.openingWaterCrestLayer}`} viewBox="0 0 1600 1000" preserveAspectRatio="none" aria-hidden="true" style={reduceMotion ? undefined : { y: rideY }}>
      <path className={styles.openingWaterCrest} d={SEA_CREST_SHAPE} />
    </motion.svg>
  );
}

function RevealCap({progress,width,height,index}:{progress:MotionValue<number>;width:number;height:number;index:number}) {
  const d=useTransform(progress,p=>liquidReveal(p,width,height).caps[index]?.d??'M0 0Z');
  return <motion.path d={d} fill="white" />;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function SeaLife({progress,reduced}:{progress:MotionValue<number>;reduced:boolean|null}) {
  const ref=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(false);
  const x=useTransform(progress,[0,.35],[24,-24]);
  const y=useTransform(progress,[0,.35],[0,14]);
  useEffect(()=>{
    if(reduced||!ref.current)return;
    let inView=false;
    const sync=()=>setVisible(inView&&!document.hidden);
    const observer=new IntersectionObserver(([entry])=>{inView=entry.isIntersecting;sync();});
    observer.observe(ref.current);
    document.addEventListener('visibilitychange',sync);
    return ()=>{observer.disconnect();document.removeEventListener('visibilitychange',sync);};
  },[reduced]);
  return <motion.div ref={ref} className={styles.seaLife} data-visible={visible} data-testid="sea-life" aria-hidden="true" style={reduced?undefined:{x,y}}>
    <svg className={styles.fishSchool} viewBox="0 0 1536 1024">
      <defs><filter id="fish-blue-matte" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  3 3 -3 0 .25" />
        <feComponentTransfer><feFuncA type="linear" slope="4" intercept="-.5" /></feComponentTransfer>
      </filter></defs>
      <image href="/brand/ocean-life/fish-school-v1.png" width="1536" height="1024" filter="url(#fish-blue-matte)" />
    </svg>
    <svg className={styles.seaBubbles} viewBox="0 0 60 110"><circle cx="30" cy="84" r="8"/><circle cx="43" cy="50" r="5"/><circle cx="25" cy="20" r="3"/></svg>
  </motion.div>;
}

function OpeningFrontWater({ progress, storyProgress, rideY, reduceMotion, width, height }: { progress:MotionValue<number>;storyProgress:MotionValue<number>;rideY:MotionValue<string>;reduceMotion:boolean|null;width:number;height:number }) {
  const geometry=useMemo(()=>liquidGeometry(width,height),[width,height]);
  const bodyShape=useTransform(()=>liquidGeometry(width,height,
    .25*Math.max(0,Math.min(1,(progress.get()-.6)/.4))+
    .75*Math.max(0,Math.min(1,storyProgress.get()/.25))).d);
  const maskHeight=useTransform(storyProgress,p=>liquidReveal(p,width,height).flat);
  return <motion.div className={styles.liquidWorld} style={reduceMotion?undefined:{y:rideY}} data-testid="liquid-world">
    <svg className={styles.liquidSurface} width={width} height={geometry.height} style={{ width, height: geometry.height }} viewBox={`0 0 ${width} ${geometry.height}`} aria-hidden="true" data-testid="continuous-water">
      <defs><mask id="liquid-progress" maskUnits="userSpaceOnUse" x={-width} y={0} width={width*3} height={geometry.height+500}>
        <motion.rect x={-width} y={0} width={width*3} height={reduceMotion?geometry.height+500:maskHeight} fill="white" />
        <RevealCap progress={storyProgress} width={width} height={height} index={0} />
        <RevealCap progress={storyProgress} width={width} height={height} index={1} />
      </mask></defs>
      <motion.path className={styles.openingWaterMain} fillRule="evenodd" d={reduceMotion?geometry.d:bodyShape} mask="url(#liquid-progress)" />
    </svg>
    <div className={styles.waterIntro} data-testid="water-intro">
      <h2>两种感受，<br />都值得先被看见。</h2>
      <p>海水汇成一条路。它先承接一个人的声音，<br className={styles.desktopBreak} />再分开容纳两个人，最后带着确认过的理解重新汇合。</p>
    </div>
    <OceanLife progress={storyProgress} reduced={reduceMotion} />
    <RiverPeople width={width} height={height} reduced={reduceMotion} />
  </motion.div>;
}

// New generated raster artwork, clipped to its real silhouette to exclude
// the generator's translucent outer halo. Geometry is in native art pixels.
function CleanBoat() {
  return <svg viewBox="0 0 1536 1024" width="100%" height="100%" aria-label="海面上的蓝色小船" role="img" data-testid="clean-boat">
    <defs><clipPath id="deepwe-boat-silhouette-v2">
      <path d="M305 711 L311 691 L351 676 L378 684 L390 713 Q511 751 600 758 Q908 748 1235 647 L1236 632 L1281 619 L1313 630 L1305 653 C1354 671 1393 705 1362 753 C1335 849 1234 948 1180 970 L1156 980 C993 981 526 943 416 917 C360 905 332 840 306 742 Z" />
      <path d="M1269 348 L1291 350 L1256 625 L1238 630 Z M1291 358 C1351 352 1372 390 1407 392 C1445 391 1462 425 1509 441 C1483 473 1462 502 1420 499 C1366 495 1345 521 1300 517 L1272 511 Z" />
      <circle cx="1284" cy="330" r="17" />
    </clipPath></defs>
    <image href="/brand/generated/deepwe-boat-flat-v2.png" width="1536" height="1024" clipPath="url(#deepwe-boat-silhouette-v2)" />
  </svg>;
}

function OpeningClouds({ progress, reduced }: {progress: MotionValue<number>; reduced: boolean | null}) {
  // Scroll is the clock: stop immediately with it, reverse without replay.
  const far = useTransform(progress, [0, 1], ['0vw', '-24vw']);
  const near = useTransform(progress, [0, 1], ['0vw', '-36vw']);
  const path = 'M0 73 C20 67 43 66 60 48 C78 28 89 5 110 10 C132 15 136 46 166 48 C197 50 205 29 228 36 C253 43 258 63 280 61 C303 59 307 45 323 52 C346 70 364 72 390 74 C375 89 328 89 300 85 C269 79 250 94 211 88 C178 82 164 81 140 85 C89 97 31 95 0 80 Z';
  return <div className={styles.openingClouds} aria-hidden="true" data-testid="opening-clouds">
    <motion.svg viewBox="0 0 390 100" className={styles.openingCloudFar} style={reduced ? undefined : {x:far}} data-testid="cloud-far"><path d={path}/></motion.svg>
    <motion.svg viewBox="0 0 390 100" className={styles.openingCloudNear} style={reduced ? undefined : {x:near}} data-testid="cloud-near"><path d={path}/></motion.svg>
    <motion.svg viewBox="0 0 390 100" className={styles.openingCloudSmall} style={reduced ? undefined : {x:far}}><path d={path}/></motion.svg>
  </div>;
}

export function OpeningSequence({ sequenceRef, progress, storyProgress, width, height }: { sequenceRef: RefObject<HTMLElement | null>; progress: MotionValue<number>; storyProgress: MotionValue<number>; width:number; height:number }) {
  const reduceMotion = useReducedMotion();
  const boatRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const bob = useMotionValue(0);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || reduceMotion) { bob.set(0); return; }
    let frame = 0, elapsed = 0, previous = 0, visible = false;
    const tick = (now: number) => {
      if (previous) elapsed += now - previous;
      previous = now;
      bob.set(boatBob(elapsed));
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      previous = 0;
      if (visible && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(scene);
    document.addEventListener("visibilitychange", sync);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [bob, reduceMotion]);

  // Keep the copy on its original left anchor. The solid foreground water is
  // the only visible mask; the copy never performs an independent exit that
  // could expose it above or beside the converging water.
  const copyScale = useTransform(progress, [0, 0.48, 0.64, 1], [1, 0.98, 0.84, 0.84]);
  const copyVisibility = useTransform(progress, (value): "visible" | "hidden" => value < 0.835 ? "visible" : "hidden");
  const seaRideY = useTransform(progress, [0, 0.55, 0.72, 0.86, 1], ["0vh", "0vh", "-24vh", "-60vh", "-96vh"]);

  return (
    <section id="top" ref={sequenceRef} className={styles.openingSequence} aria-label="DeepWe 开场与双人跃入海面的滚动动画">
      <link rel="preload" as="image" href="/brand/generated/deepwe-boat-flat-v2.png" />
      <div className={styles.openingSticky}>
        <OpeningClouds progress={progress} reduced={reduceMotion} />
        <motion.div className={styles.heroCopy} style={reduceMotion ? undefined : { scale: copyScale, visibility: copyVisibility }}>
          <h1>Deep We</h1>
          <p>深入彼此的情感</p>
          <span>让两个人的关系，不只停留在浅滩的浪漫。</span>
          <span>一起看见彼此，也看见自己。</span>
        </motion.div>

        <div className={styles.oceanStage}>
          <OpeningBackWaves rideY={seaRideY} reduceMotion={reduceMotion} />
          <motion.div ref={sceneRef} className={styles.boatScene} style={{ y: bob }} data-testid="boat-scene">
          <div ref={boatRef} className={styles.boatRig} data-testid="boat-rig">
            <motion.div className={styles.boatRide} style={reduceMotion ? undefined : { y: seaRideY }}>
              <div className={styles.boat}>
                <CleanBoat />
              </div>
            </motion.div>
          </div>
          <HeroCouple progress={progress} reduceMotion={reduceMotion} boatRef={boatRef} bob={bob} />
          </motion.div>
          <OpeningCrestWave rideY={seaRideY} reduceMotion={reduceMotion} />
          <OpeningFrontWater progress={progress} storyProgress={storyProgress} rideY={seaRideY} reduceMotion={reduceMotion} width={width} height={height} />
        </div>

      </div>
    </section>
  );
}

// Retained as an editable vector fallback for future art-direction passes.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ListenFigure() {
  return (
    <svg className={styles.sceneFigure} viewBox="0 0 900 700" role="img" aria-label="一位年轻女性伏在单股水流上整理想法">
      <g transform="translate(22 28)">
        <path fill="#65c95c" d="M250 294c44-57 114-78 183-49 49 20 77 71 62 120-17 56-77 80-142 64l-116-29c-52-13-63-63-25-88l38-18Z" />
        <path fill="#ff705f" d="M386 271c41-23 91-10 115 28l37 61-91 42-54-58c-24-26-28-57-7-73Z" />
        <circle cx="526" cy="271" r="61" fill="#ffbe9f" />
        <path fill="#222b2d" d="M477 259c0-43 26-76 70-70 32 4 52 28 54 58-18-9-36-14-54-13-21 2-43 12-70 25Z" />
        <circle cx="548" cy="274" r="5" fill="#233037" />
          <path className={styles.figureLine} d="M558 296c13 8 25 6 34-4" />
        <path fill="#ffbe9f" d="M418 326c41 0 73 14 101 43l-33 35c-26-25-52-35-82-30l14-48Z" />
        <circle cx="492" cy="386" r="18" fill="#ffbe9f" />
        <path fill="#ffbe9f" d="M358 317c-21 15-39 39-52 73-9 24-9 50 4 74l39-20c-8-18-7-34 2-50 13-22 29-38 48-48l-41-29Z" />
        <circle cx="333" cy="458" r="19" fill="#ffbe9f" />
        <g className={styles.limbMotionA}>
          <path fill="#d9b8f3" d="M268 390c-51 20-92 58-119 113l72 33c27-43 65-64 113-72l-66-74Z" />
          <path fill="#ffbe9f" d="M164 505c-16 18-27 41-31 68l45 7c5-23 17-40 34-52l-48-23Z" />
          <path fill="#ffd91f" d="M125 563c-8 18-4 37 13 53 23 21 58 12 77-20l-40-27c-13 13-25 11-50-6Z" />
        </g>
        <g className={styles.limbMotionB}>
          <path fill="#d9b8f3" d="M319 413c-17 50-17 97 3 142l78-28c-12-37-6-72 18-105l-99-9Z" />
          <path fill="#ffbe9f" d="M323 543c-2 25 5 48 22 68l38-28c-12-17-15-35-9-53l-51 13Z" />
          <path fill="#ff705f" d="M340 596c8 25 29 38 61 36 30-2 44-22 40-49l-53 2c-8 16-18 20-48 11Z" />
        </g>
        <path fill="#fff" d="M590 326l70 11-11 94-70-10z" />
        <path fill="#ff705f" d="M594 326l66 11-2 12-66-11z" />
      </g>
    </svg>
  );
}

// Retained as an editable vector fallback for future art-direction passes.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CoupleFigure() {
  return (
    <svg className={styles.sceneFigure} viewBox="0 0 900 700" role="img" aria-label="两位年轻伴侣分别攀附在两股水流上">
      <g transform="translate(34 10)">
        <g transform="translate(120 52)">
          <circle cx="187" cy="150" r="48" fill="#ffbe9f" />
          <path fill="#252d2e" d="M142 145c1-39 21-66 58-64 28 1 48 19 52 47-20-8-34-10-49-8-20 2-39 11-61 25Z" />
          <path fill="#ff705f" d="M132 198c37-24 90-16 117 19 22 29 24 70 5 112l-111-9c-28-54-31-93-11-122Z" />
          <path fill="#ffbe9f" d="M157 222c-34 25-57 60-66 104l39 9c13-36 32-61 59-75l-32-38Z" />
          <circle cx="108" cy="334" r="17" fill="#ffbe9f" />
          <path fill="#ffbe9f" d="M222 218c31 10 54 32 68 65l-38 19c-14-24-31-39-53-44l23-40Z" />
          <circle cx="270" cy="301" r="17" fill="#ffbe9f" />
          <g className={styles.limbMotionA}>
            <path fill="#f7efe3" d="M151 313c-22 61-24 119-4 173l69-21c-13-46-7-88 19-125l-84-27Z" />
            <path fill="#ffbe9f" d="M145 470c-4 30 1 55 16 76l36-22c-9-17-11-36-6-55l-46 1Z" />
            <path fill="#65c95c" d="M151 532c2 27 20 43 54 47 30 3 47-12 51-39l-48-9c-12 13-26 14-57 1Z" />
          </g>
          <path fill="#f7efe3" d="M208 320c16 51 48 91 97 119l36-62c-38-24-58-55-62-95l-71 38Z" />
          <path fill="#ffd91f" d="M292 419c13 22 34 32 65 29 29-3 42-22 37-50l-48 1c-9 15-22 20-54 20Z" />
        </g>
        <g transform="translate(470 92)">
          <circle cx="166" cy="139" r="48" fill="#9ddfe0" />
          <path fill="#252d2e" d="M121 135c0-38 25-64 62-61 27 2 47 21 49 49-19-8-35-11-50-9-19 2-38 10-61 21Z" />
          <path fill="#ffd91f" d="M109 190c38-21 86-12 109 22 21 31 19 72-4 112l-109-17c-21-51-20-90 4-117Z" />
          <path fill="#9ddfe0" d="M126 213c-31 19-55 46-70 82l34 16c16-30 37-49 63-58l-27-40Z" />
          <circle cx="71" cy="307" r="16" fill="#9ddfe0" />
          <path fill="#9ddfe0" d="M199 215c29 13 50 36 60 69l-38 15c-10-24-26-40-47-48l25-36Z" />
          <circle cx="239" cy="297" r="16" fill="#9ddfe0" />
          <path fill="#d9b8f3" d="M120 303c-24 45-30 93-20 143l70-9c-4-39 6-72 31-101l-81-33Z" />
          <g className={styles.limbMotionB}>
            <path fill="#d9b8f3" d="M176 320c20 47 54 82 102 104l30-64c-37-20-57-48-62-85l-70 45Z" />
            <path fill="#ff705f" d="M268 405c15 24 37 34 67 28 28-6 38-26 31-51l-45 5c-8 14-23 20-53 18Z" />
          </g>
          <path fill="#65c95c" d="M97 429c-3 29 13 48 47 56 30 7 49-6 56-33l-47-14c-13 12-26 11-56-9Z" />
        </g>
      </g>
    </svg>
  );
}

// Retained as an editable vector fallback for future art-direction passes.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function UnderstandFigure() {
  return (
    <svg className={styles.sceneFigure} viewBox="0 0 900 700" role="img" aria-label="一对中年伴侣在两股水流汇合处互相伸手">
      <g transform="translate(42 74)">
        <g transform="translate(92 82)">
          <circle cx="205" cy="135" r="51" fill="#e79b73" />
          <path fill="#4b5052" d="M158 125c2-38 26-63 62-59 27 3 46 21 49 48-20-7-37-8-54-5-19 3-37 9-57 16Z" />
          <path fill="#65c95c" d="M140 188c43-19 91-5 111 34 19 37 12 80-19 120l-112-29c-14-52-7-94 20-125Z" />
          <path fill="#e79b73" d="M225 213c44 10 78 33 101 69l-37 25c-21-27-47-42-77-44l13-50Z" />
          <circle cx="307" cy="300" r="18" fill="#e79b73" />
          <path fill="#f7efe3" d="M129 309c-21 61-18 115 10 163l68-34c-20-40-20-79 1-116l-79-13Z" />
          <g className={styles.limbMotionA}>
            <path fill="#f7efe3" d="M187 326c14 53 45 92 91 118l36-63c-34-23-51-52-50-88l-77 33Z" />
            <path fill="#ffd91f" d="M268 428c15 24 38 32 69 24 28-8 38-27 29-54l-47 8c-7 15-22 22-51 22Z" />
          </g>
        </g>
        <g transform="translate(458 98)">
          <circle cx="157" cy="125" r="49" fill="#ffbe9f" />
          <path fill="#6c7376" d="M112 121c0-37 24-62 59-59 27 2 46 20 49 47-18-7-34-9-50-7-19 2-38 9-58 19Z" />
          <circle cx="193" cy="76" r="30" fill="#6c7376" />
          <path fill="#ff705f" d="M100 180c39-21 87-10 111 25 20 31 18 73-5 115l-110-20c-20-50-19-91 4-120Z" />
          <path fill="#ffbe9f" d="M112 207c-43 11-77 35-102 70l35 27c22-27 48-42 79-44l-12-53Z" />
          <circle cx="28" cy="295" r="18" fill="#ffbe9f" />
          <path fill="#d9b8f3" d="M105 295c-16 58-10 111 19 157l64-37c-22-38-23-76-4-112l-79-8Z" />
          <g className={styles.limbMotionB}>
            <path fill="#d9b8f3" d="M165 309c17 50 48 87 95 111l33-64c-35-21-53-49-55-85l-73 38Z" />
            <path fill="#65c95c" d="M251 402c15 23 37 31 66 24 27-7 38-26 30-52l-46 6c-8 15-22 21-50 22Z" />
          </g>
          <path fill="#ffd91f" d="M116 438c0 28 17 45 51 50 29 4 47-10 52-37l-47-11c-12 13-27 13-56-2Z" />
        </g>
      </g>
    </svg>
  );
}

// Retained as an editable vector fallback for future art-direction passes.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function RecordsFigure() {
  return (
    <svg className={styles.sceneFigure} viewBox="0 0 900 700" role="img" aria-label="一对年长伴侣坐在同一股水流上回看记录">
      <g transform="translate(96 96)">
        <g transform="translate(120 26)">
          <circle cx="176" cy="142" r="53" fill="#d98b64" />
          <path fill="#f4f1e8" d="M132 129c2-38 25-63 61-60 27 2 47 21 50 48-19-8-35-10-51-8-20 2-39 9-60 20Z" />
          <path fill="#f4f1e8" d="M143 160c12 31 34 48 68 50 2 28-14 48-43 49-34 2-55-33-25-99Z" />
          <path fill="#d9b8f3" d="M113 205c42-22 92-11 116 26 21 32 18 76-7 120l-116-19c-20-54-18-96 7-127Z" />
          <path fill="#d98b64" d="M203 237c43 9 76 31 99 66l-37 26c-21-27-45-41-75-43l13-49Z" />
          <circle cx="284" cy="321" r="18" fill="#d98b64" />
          <g className={styles.limbMotionA}>
            <path fill="#65c95c" d="M118 326c-13 58-5 111 24 157l65-38c-22-38-24-76-7-112l-82-7Z" />
            <path fill="#ffd91f" d="M136 469c0 27 18 44 51 48 29 4 47-11 51-38l-47-10c-12 13-27 14-55 0Z" />
          </g>
          <path fill="#65c95c" d="M181 338c19 50 53 85 101 106l29-66c-37-19-57-47-60-84l-70 44Z" />
        </g>
        <g transform="translate(414 54)">
          <circle cx="166" cy="125" r="50" fill="#ffbe9f" />
          <path fill="#8d9293" d="M119 118c2-37 26-62 61-58 27 3 46 21 48 48-19-7-35-9-50-7-20 2-39 9-59 17Z" />
          <circle cx="199" cy="72" r="31" fill="#8d9293" />
          <path fill="#ff705f" d="M107 180c41-20 89-7 111 29 20 33 15 76-12 117l-112-25c-17-52-12-93 13-121Z" />
          <path fill="#ffbe9f" d="M118 217c-35 13-62 36-81 69l36 23c17-25 38-40 64-44l-19-48Z" />
          <circle cx="55" cy="299" r="17" fill="#ffbe9f" />
          <path fill="#f7efe3" d="M102 298c-19 59-15 112 13 159l66-35c-21-39-22-78-2-115l-77-9Z" />
          <g className={styles.limbMotionB}>
            <path fill="#f7efe3" d="M163 314c17 51 49 88 96 112l33-64c-36-22-54-50-55-87l-74 39Z" />
            <path fill="#ff705f" d="M250 410c14 23 36 32 66 25 28-7 39-26 31-52l-46 6c-8 15-23 21-51 21Z" />
          </g>
          <path fill="#ffd91f" d="M108 441c0 28 18 45 51 49 29 4 47-10 52-37l-48-11c-12 13-26 14-55-1Z" />
        </g>
        <g transform="translate(357 246) rotate(6)">
          <rect width="96" height="126" rx="8" fill="#fff" />
          <rect x="18" y="24" width="60" height="7" rx="3.5" fill="#89cfff" />
          <rect x="18" y="45" width="44" height="7" rx="3.5" fill="#d9b8f3" />
          <rect x="18" y="66" width="55" height="7" rx="3.5" fill="#65c95c" />
        </g>
      </g>
    </svg>
  );
}

function StoryScene({ scene, index }: { scene: (typeof STORY_SCENES)[number]; index: number }) {
  return (
    <article style={{top:SCENE_POSITIONS[index]/FLOW_UNITS*100+'%'}} id={scene.id} data-scene={scene.id} className={`${styles.storyScene} ${index % 2 ? styles.sceneReverse : ""}`}>
      <div className={styles.businessDialog}>
        <strong className={styles.dialogLabel}>{scene.label}</strong>
        <h2>{scene.title}</h2>
        <p>{scene.body}</p>
        <small>{scene.note}</small>
        <Link href={scene.href}>{scene.action}<i><ArrowIcon /></i></Link>
      </div>
    </article>
  );
}

export function StoryJourney({ storyRef, width }: { storyRef: RefObject<HTMLElement | null>;width:number }) {
  return (
    <section style={{height:flowHeight(width),minHeight:flowHeight(width)}} ref={storyRef} className={styles.storyJourney} aria-label="沿着蓝色水流了解 DeepWe 的四个核心功能">
      <div className={styles.reducedIntro}>
        <h2>两种感受，<br />都值得先被看见。</h2>
        <p>海水汇成一条路。它先承接一个人的声音，再分开容纳两个人，最后带着确认过的理解重新汇合。</p>
      </div>

      <div className={styles.storyScenes}>
        {STORY_SCENES.map((scene, index) => <StoryScene key={scene.id} scene={scene} index={index} />)}
      </div>
    </section>
  );
}

export function WaterNarrative() {
  const {width,height}=useViewport();
  const openingRef = useRef<HTMLElement>(null);
  const storyRef = useRef<HTMLElement>(null);
  const { scrollYProgress: openingProgress } = useScroll({ target: openingRef, offset: ["start start", "end end"] });
  const { scrollYProgress: storyProgress } = useScroll({ target: storyRef, offset: ["start end", "end end"] });

  return (
    <div className={styles.waterNarrative}>
      <OpeningSequence sequenceRef={openingRef} progress={openingProgress} storyProgress={storyProgress} width={width} height={height} />
      <StoryJourney storyRef={storyRef} width={width} />
    </div>
  );
}
