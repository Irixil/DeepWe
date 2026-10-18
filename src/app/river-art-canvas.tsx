"use client";

import { useEffect, useRef } from "react";
import { MAX_ZONES, motionZones, headLocks, zoneAngle, vertexShader, fragmentShader } from "@/lib/river-art-motion.mjs";

type Props = {
  id: string; part: string; file: string; width: number; height: number;
  scale: number; active: boolean; reduced: boolean | null;
  onReady: (ready: boolean) => void;
};

// One connected surface, one source texture. Only authored local limb fields
// move; there are no cutout wrists, duplicated hands, or replaced face frames.
export function RiverArtCanvas({ id, part, file, width, height, scale, active, reduced, onReady }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playback = useRef({ active, reduced });
  const wakeRef = useRef<(() => void) | null>(null);
  useEffect(() => { playback.current = { active, reduced }; wakeRef.current?.(); }, [active, reduced]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reduced) return;
    const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) return;
    let disposed = false, frame = 0, elapsed = 0, previous = 0;
    let texture: WebGLTexture | null = null, buffer: WebGLBuffer | null = null;
    let program: WebGLProgram | null = null;
    const shaders: WebGLShader[] = [];
    const image = new Image();
    const zones = motionZones(id, part);
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Illustration shader unavailable");
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Illustration shader failed");
      return shader;
    };
    const fail = () => { onReady(false); cancelAnimationFrame(frame); };
    const lost = (event: Event) => { event.preventDefault(); fail(); };
    canvas.addEventListener("webglcontextlost", lost);
    let draw: ((time: number) => void) | undefined;
    const tick = (now: number) => {
      frame = 0;
      if (disposed || !playback.current.active || playback.current.reduced || document.hidden) { previous = 0; return; }
      if (previous) elapsed += Math.min((now-previous)/1000, .05);
      previous = now;
      draw?.(elapsed);
      frame = requestAnimationFrame(tick);
    };
    const wake = () => {
      if (!frame && draw && playback.current.active && !playback.current.reduced && !document.hidden) frame = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;
    document.addEventListener("visibilitychange", wake);
    image.onload = () => {
      if (disposed) return;
      try {
        program = gl.createProgram();
        if (!program) return;
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexShader));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentShader));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Illustration program failed");
        gl.useProgram(program);
        const density = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.max(1, Math.min(width, Math.ceil(width*scale*density)));
        canvas.height = Math.max(1, Math.min(height, Math.ceil(height*scale*density)));
        gl.viewport(0, 0, canvas.width, canvas.height);
        const vertices: number[] = [];
        const cols = Math.ceil(width/16), rows = Math.ceil(height/16);
        for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
          const x0=x/cols*width,x1=(x+1)/cols*width,y0=y/rows*height,y1=(y+1)/rows*height;
          vertices.push(x0,y0,x1,y0,x0,y1,x0,y1,x1,y0,x1,y1);
        }
        buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, "aPosition");
        gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(program,"uSize"),width,height);
        texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
        const zoneData = new Float32Array(MAX_ZONES*4), motionData = new Float32Array(MAX_ZONES*3);
        zones.forEach((z,i) => zoneData.set(z.slice(0,4),i*4));
        gl.uniform4fv(gl.getUniformLocation(program,"uZone[0]"),zoneData);
        const headData = new Float32Array(8);
        headLocks(id,part).forEach((h,i)=>headData.set(h,i*4));
        gl.uniform4fv(gl.getUniformLocation(program,"uHead[0]"),headData);
        const motionUniform=gl.getUniformLocation(program,"uMotion[0]");
        const query = new URLSearchParams(window.location.search);
        const reviewTime = query.has('artTime') ? Math.max(0,Number(query.get('artTime')) || 0) : null;
        draw = time => {
          zones.forEach((z,i)=>motionData.set([z[4],z[5],zoneAngle(z,time)],i*3));
          gl.uniform3fv(motionUniform,motionData);
          gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES,0,vertices.length/2);
          canvas.dataset.artTime=time.toFixed(2);
        };
        draw(reviewTime ?? 0); onReady(true);
        if (reviewTime === null) wake();
        else draw = undefined;
      } catch { fail(); }
    };
    image.onerror = fail;
    image.src = '/brand/river-people/' + file;
    return () => {
      disposed = true; cancelAnimationFrame(frame); wakeRef.current = null;
      document.removeEventListener("visibilitychange", wake); canvas.removeEventListener("webglcontextlost", lost);
      image.onload = null; image.onerror = null;
      if (texture) gl.deleteTexture(texture); if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program); shaders.forEach(shader=>gl.deleteShader(shader));
      onReady(false);
    };
  }, [id, part, file, width, height, scale, reduced, onReady]);
  return <canvas ref={canvasRef} aria-hidden="true" data-motion-art={id+'-'+part} style={{ display:'block', width, height }} />;
}
