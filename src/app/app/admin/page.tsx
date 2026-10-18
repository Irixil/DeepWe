"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AdminAnalyticsPanel from "../AdminAnalyticsPanel";
import PrivateAccountBoundary from "../PrivateAccountBoundary";
import { getCurrentAccount } from "@/lib/api";
import type { AccountUser } from "@/lib/types";
import styles from "./admin.module.css";

export default function AdminPage() {
  return <PrivateAccountBoundary><AdminScreen /></PrivateAccountBoundary>;
}

function AdminScreen() {
  const [account, setAccount] = useState<AccountUser | null | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getCurrentAccount().then((result) => {
      if (!active) return;
      setAccount(result.user ?? null);
      if (result.error) setError(result.error);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return <main className={`${styles.shell} deepwe-app-shell`}>
    <header className={styles.topbar}><Link href="/app" className={styles.brand}>DeepWe <span>深蓝</span></Link><Link href="/app" className={styles.back}>返回私密对话</Link></header>
    <div className={styles.content}>
      {loading ? <p className={styles.state} role="status">正在打开管理面板…</p> : error ? <section className={styles.state} role="alert"><h1>暂时无法打开管理面板</h1><p>{error}</p><Link href="/app">返回</Link></section> : account?.isOwner === true ? <><h1>管理面板</h1><p className={styles.intro}>这里展示产品使用情况的汇总数据，不包含私密聊天、分享草稿或个人对话轨迹。</p><AdminAnalyticsPanel /></> : <section className={styles.state} role="alert"><h1>{account ? "此账号没有管理权限" : "请先登录"}</h1><p>{account ? "此账号没有管理权限。" : "请登录后再访问管理面板。"}</p><Link href="/app">返回私密空间</Link></section>}
    </div>
  </main>;
}
