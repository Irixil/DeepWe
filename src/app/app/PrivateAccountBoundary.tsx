"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { getCurrentAccount } from "@/lib/api";
import { getAccountSessionRevision, notifyAccountSessionChanged, subscribeAccountSessionChanged } from "@/lib/account-session";
import styles from "./private.module.css";

// Unmount the whole previous private view, including editable drafts and late async setters.
export default function PrivateAccountBoundary({ children }: { children: ReactNode }) {
  const [view, setView] = useState({ checking: true, mounted: false, generation: 0 });
  const [verifiedAnonymous, setVerifiedAnonymous] = useState(false);
  useEffect(() => {
    let active = true;
    let requestId = 0;
    let ownerId: string | null | undefined;
    const revalidate = (accountChanged = false) => {
      const request = ++requestId;
      const sessionRevision = getAccountSessionRevision();
      if (accountChanged) setVerifiedAnonymous(false);
      setView((current) => ({ checking: true, mounted: accountChanged ? false : current.mounted,
        generation: current.generation + (accountChanged ? 1 : 0) }));
      if (document.visibilityState !== "visible") return;
      void getCurrentAccount().then((result) => {
        if (!active || request !== requestId || sessionRevision !== getAccountSessionRevision()) return;
        const nextOwnerId = result.error ? null : result.user?.id ?? null;
        const changed = ownerId !== undefined && ownerId !== nextOwnerId;
        ownerId = nextOwnerId;
        if (changed && !result.error) {
          // Also discard in-flight results when the fallback identity check detects a change.
          notifyAccountSessionChanged();
          return;
        }
        setVerifiedAnonymous(!result.error && !result.user);
        setView((current) => ({ checking: false, mounted: true,
          generation: current.generation + (changed || Boolean(result.error) ? 1 : 0) }));
      });
    };
    const onReturn = () => revalidate();
    const unsubscribe = subscribeAccountSessionChanged(() => revalidate(true));
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    void Promise.resolve().then(() => { if (active) revalidate(); });
    return () => {
      active = false;
      requestId += 1;
      unsubscribe();
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pageshow", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  const hideChildren = !view.mounted || (view.checking && !verifiedAnonymous);
  return <>
    <div hidden={hideChildren} style={hideChildren ? { display: "none" } : undefined}>
      {view.mounted && <Fragment key={view.generation}>{children}</Fragment>}
    </div>
    {view.checking && hideChildren && <main className={`${styles.shell} deepwe-app-shell`}><p role="status">正在核对账号…</p></main>}
  </>;
}
