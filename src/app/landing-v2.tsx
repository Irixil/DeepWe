import Link from "next/link";
import { WaterNarrative } from "./landing-motion";
import styles from "./landing-v2.module.css";

const NAV_ITEMS = [
  ["#listen", "潜谈"],
  ["#couple", "双人复盘"],
  ["#understand", "共同理解"],
  ["#records", "记录"],
] as const;

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 8h14M5 16h14" />
    </svg>
  );
}

function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className={`${styles.logo} ${light ? styles.logoLight : ""}`} aria-label="DeepWe 深蓝">
      <span>DeepWe</span>
      <small>深蓝</small>
    </span>
  );
}

function FloatingNavigation() {
  return (
    <header className={styles.navWrap}>
      <div className={styles.navMain}>
        <Link href="#top" className={styles.logoLink}>
          <Logo />
        </Link>
        <nav aria-label="DeepWe 首页导航">
          {NAV_ITEMS.map(([href, label]) => (
            <a key={href} href={href}>{label}</a>
          ))}
        </nav>
        <span className={styles.subscription}>订阅服务 · 即将开放</span>
        <details className={styles.navMenu}>
          <summary aria-label="打开导航菜单"><MenuIcon /></summary>
          <div>
            {NAV_ITEMS.map(([href, label]) => (
              <a key={href} href={href}>{label}</a>
            ))}
            <span>订阅服务 · 即将开放</span>
          </div>
        </details>
      </div>
      <Link href="/app" className={styles.navEntry}>
        进入 DeepWe <ArrowIcon />
      </Link>
    </header>
  );
}

function SafetyBoundary() {
  return (
    <section className={styles.boundarySection} aria-labelledby="boundary-title">
      <div className={styles.boundaryCopy}>
        <h2 id="boundary-title">先被认真听见，<br />再走到彼此面前。</h2>
        <p>
          DeepWe 是关系复盘与共同理解工具。它不诊断、不裁判，也不替任何人决定关系应该走向哪里。
          遇到暴力、胁迫、自伤或他伤风险时，系统会优先提醒现实安全与专业支持。
        </p>
      </div>
      <ul>
        <li><i>01</i><span><strong>原始表达只属于本人</strong><small>伴侣不会看到你的私密潜谈。</small></span></li>
        <li><i>02</i><span><strong>确认过的内容才会共享</strong><small>你始终知道什么会进入共同空间。</small></span></li>
        <li><i>03</i><span><strong>安全永远比流程重要</strong><small>你可以暂停、跳过，或寻找现实支持。</small></span></li>
      </ul>
    </section>
  );
}

function ClosingSection() {
  return (
    <>
      <section className={styles.finalSection}>
        <Logo light />
        <h2>从一件具体的事开始，<br />慢慢走进彼此深处。</h2>
        <p>不用一次想清楚。先说出此刻最在意的是什么。</p>
        <Link href="/app">进入 DeepWe <ArrowIcon /></Link>
        <span>订阅服务正在准备中</span>
      </section>
      <footer className={styles.footer}>
        <Logo />
        <p>双人异步冲突复盘与共同理解工具</p>
        <small>DeepWe 不能替代专业心理咨询、医疗诊断或紧急援助。</small>
      </footer>
    </>
  );
}

export default function NewLandingPage() {
  return (
    <main className={styles.landing} data-design-direction="deepwe-flat-current-v5">
      {/*
        THESIS: separate private voices can meet as shared understanding.
        STORY: meet the couple, dive below the surface, follow one blue current through four real product moments.
        FORM: warm editorial canvas, varied flat-vector people, broad cobalt current, white business dialogs.
      */}
      <FloatingNavigation />
      <WaterNarrative />
      <SafetyBoundary />
      <ClosingSection />
    </main>
  );
}
