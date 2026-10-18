"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { getEvent } from "@/lib/api";
import type { EventData } from "@/lib/types";
import EventView from "./EventView";
import PrivateAccountBoundary from "@/app/app/PrivateAccountBoundary";

export default function EventPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  return <PrivateAccountBoundary><EventScreen key={id} id={id} /></PrivateAccountBoundary>;
}

function EventScreen({ id }: { id: string }) {
  const [data, setData] = useState<EventData | null>(null);
  const [missing, setMissing] = useState(false);
  const activeRef = useRef(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!activeRef.current) return;
    const request = ++requestRef.current;
    const d = await getEvent(id);
    if (!activeRef.current || request !== requestRef.current) return;
    if (d.error) {
      // Transient failures retain this owner's view; lost access removes all event state.
      if (d.status === 401 || d.status === 403 || d.status === 404) {
        setData(null);
        setMissing(true);
      }
      return;
    }
    setMissing(false);
    setData(d);
  }, [id]);

  useEffect(() => {
    activeRef.current = true;
    // 初始读取后持续轻量刷新。短暂断线时保留现有页面，恢复后自动接上。
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 2500);
    return () => {
      activeRef.current = false;
      requestRef.current += 1;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  if (missing) {
    return (
      <main className="deepwe-event-shell mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-5">
        <p className="text-center text-sm text-slate-500">这个事件不存在或已被删除。</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="deepwe-event-shell mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-5">
        <p className="text-center text-sm text-slate-400">加载中…</p>
      </main>
    );
  }

  return <EventView data={data} onRefresh={refresh} />;
}
