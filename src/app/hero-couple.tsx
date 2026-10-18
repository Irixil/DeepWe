"use client";

import { useEffect, useRef, type RefObject } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { createCompleteRig } from "@/lib/hero-rig/complete-rig.mjs";
import { sample, W, H } from "@/lib/hero-rig/motion.mjs";
import { stagePhase, stagePlacement } from "@/lib/hero-rig/stage.mjs";
import styles from "./landing-v2.module.css";

/** The approved rig is sampled directly: no pose swaps, extra scale track or spring. */
export function HeroCouple({ progress, reduceMotion, boatRef, bob }: {
  progress: MotionValue<number>;
  reduceMotion: boolean | null;
  boatRef: RefObject<HTMLDivElement | null>;
  bob: MotionValue<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const footRef = useRef<HTMLCanvasElement>(null);
  // The shared parent supplies all bobbing. Cancel it continuously only as
  // the passengers leave; at rest there is no independent passenger clock.
  const counterBob = useTransform(() => -bob.get() * stagePhase(progress.get(), !!reduceMotion).detached);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const footCanvas = footRef.current;
    const footCtx = footCanvas?.getContext("2d");
    if (!ctx || !footCanvas || !footCtx) return;
    const source = document.createElement("canvas");
    source.width = W;
    source.height = H;
    const texture = new window.Image();
    let disposed = false;
    let frame = 0;
    let rig: ReturnType<typeof createCompleteRig> | undefined;
    let width = 0;
    let height = 0;
    let active = true;
    let placement: ReturnType<typeof stagePlacement> | undefined;

    const draw = () => {
      frame = 0;
      if (!rig || !placement || disposed || !active || document.hidden || !width || !height) return;
      // Jump first; the existing solid sea then rises and becomes the long-page river.
      const { flight: p, detached } = stagePhase(progress.get(), !!reduceMotion);
      const pose = sample(p, true, true);
      rig.render(pose, false, 'rear');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { scale, x, y, deck } = placement;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(source, x, y, W * scale, H * scale);
      rig.render(pose, false, 'front-foot');
      footCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      footCtx.clearRect(0, 0, width, height);
      footCtx.drawImage(source, x, y, W * scale, H * scale);
      canvas.dataset.progress = p.toFixed(4);
      canvas.dataset.ready = "true";
      canvas.dataset.detached = detached.toFixed(4);
      canvas.dataset.deck = deck.map(v => v.toFixed(3)).join(",");
    };
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    const resize = new ResizeObserver(() => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const boat = boatRef.current;
      if (boat) placement = stagePlacement(width, height, {
        x: boat.offsetLeft, y: boat.offsetTop, width: boat.clientWidth, height: boat.clientHeight,
      });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      footCanvas.width = canvas.width;
      footCanvas.height = canvas.height;
      schedule();
    });
    const visibility = new IntersectionObserver(([entry]) => {
      active = entry.isIntersecting;
      schedule();
    });
    resize.observe(canvas);
    if (boatRef.current) resize.observe(boatRef.current);
    visibility.observe(canvas);
    const unsubscribe = progress.on("change", schedule);
    document.addEventListener("visibilitychange", schedule);
    texture.onload = () => {
      if (disposed) return;
      rig = createCompleteRig(source, texture);
      schedule();
    };
    texture.onerror = () => { canvas.dataset.ready = "error"; };
    texture.src = "/brand/hero-rig/characters.png";
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe();
      resize.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      texture.onload = null;
      texture.onerror = null;
    };
  }, [progress, reduceMotion, boatRef]);

  return <>
    <link rel="preload" as="image" href="/brand/hero-rig/characters.png" />
    <motion.canvas ref={canvasRef} style={{ y: counterBob }} className={styles.heroCouple} aria-hidden="true" data-testid="hero-couple" data-version="clean-boat-clouds-2" />
    <motion.canvas ref={footRef} style={{ y: counterBob }} className={`${styles.heroCouple} ${styles.heroFrontFoot}`} aria-hidden="true" data-testid="hero-front-foot" />
  </>;
}
