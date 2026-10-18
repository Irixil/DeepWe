// Only a random change signal crosses tabs; no account or private content is stored.
const EVENT = "deepwe:account-session-changed";
const STORAGE_KEY = "deepwe-account-session-change";
let revision = 0;
let initialized = false;
let channel: BroadcastChannel | null = null;
let lastSignal = "";

function applySignal(signal: unknown) {
  if (typeof signal !== "string" || !signal || signal === lastSignal) return;
  lastSignal = signal;
  revision += 1;
  window.dispatchEvent(new Event(EVENT));
}

function initialize() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try {
    channel = new BroadcastChannel(STORAGE_KEY);
    channel.onmessage = (event: MessageEvent<unknown>) => applySignal(event.data);
  } catch { /* Focus revalidation still protects browsers without this API. */ }
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) applySignal(event.newValue);
  });
}

export function getAccountSessionRevision() {
  initialize();
  return revision;
}

export function notifyAccountSessionChanged() {
  if (typeof window === "undefined") return;
  initialize();
  const signal = crypto.randomUUID();
  applySignal(signal);
  try { channel?.postMessage(signal); } catch { /* Storage/focus are fallback paths. */ }
  try { window.localStorage.setItem(STORAGE_KEY, signal); } catch { /* Storage may be disabled. */ }
}

export function subscribeAccountSessionChanged(listener: () => void) {
  initialize();
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
