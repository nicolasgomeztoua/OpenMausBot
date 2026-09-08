const ENABLED_KEY = "omb-web-push-enabled";
const CHANGE_EVENT = "omb-web-push-changed";
let registration: Promise<ServiceWorkerRegistration> | null = null;
let enabledChoice: boolean | undefined;

export function webPushUnavailableReason(): string | null {
  if (!window.isSecureContext) return "Open this app over HTTPS to enable notifications.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "On iPhone or iPad, add this app to your Home Screen, open it there, then enable notifications. Other browsers must support Web Push.";
  }
  if (Notification.permission === "denied") return "Notifications are blocked. Allow them in your browser or device settings, then try again.";
  return null;
}

export function webPushEnabled(): boolean {
  if (enabledChoice !== undefined) return enabledChoice;
  try { return localStorage.getItem(ENABLED_KEY) === "1"; }
  catch { return false; }
}

function setEnabled(value: boolean) {
  enabledChoice = value;
  try { localStorage.setItem(ENABLED_KEY, value ? "1" : "0"); } catch { /* current settings still report the action result */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onWebPushChange(listener: () => void): () => void {
  const onStorage = () => { enabledChoice = undefined; listener(); };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(CHANGE_EVENT, listener); window.removeEventListener("storage", onStorage); };
}

async function request(method: string, body?: unknown): Promise<{ publicKey: string }> {
  const response = await fetch("/api/notifications/push", {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Notification settings could not be saved.");
  return result;
}

async function worker(): Promise<ServiceWorkerRegistration> {
  registration ??= navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(() => new Promise<ServiceWorkerRegistration>((resolve, reject) => {
      // An installed worker that fails to activate must not leave Settings
      // stuck on "Preparing" indefinitely. A later explicit retry can recover.
      const timeout = setTimeout(() => reject(new Error("Notifications could not start. Try again.")), 10_000);
      void navigator.serviceWorker.ready.then(resolve, reject).finally(() => clearTimeout(timeout));
    }))
    .catch((error) => { registration = null; throw error; });
  return registration;
}

export async function prepareWebPush() {
  const reason = webPushUnavailableReason();
  if (reason) throw new Error(reason);
  const [registered, { publicKey }] = await Promise.all([worker(), request("GET")]);
  return { registration: registered, publicKey };
}

/** Called only by a settings click, with the worker/key already prepared.
 * subscribe() must run before an await so Safari retains user activation. */
export async function enableWebPush(prepared: Awaited<ReturnType<typeof prepareWebPush>>): Promise<void> {
  const subscription = await prepared.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: prepared.publicKey });
  try {
    await request("POST", subscription.toJSON());
    setEnabled(true);
  } catch (error) {
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function disableWebPush(): Promise<void> {
  const registered = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registered?.pushManager.getSubscription();
  if (subscription) {
    await request("DELETE", { endpoint: subscription.endpoint });
    setEnabled(false);
    await subscription.unsubscribe();
  } else setEnabled(false);
}

/** Restore an existing opt-in after a restart/re-pair, without ever asking
 * permission or creating a new browser subscription in the background. */
export async function restoreWebPush(): Promise<void> {
  if (!webPushEnabled()) return;
  if (webPushUnavailableReason()) { setEnabled(false); return; }
  try {
    const registered = await worker();
    const subscription = await registered.pushManager.getSubscription();
    if (!subscription) { setEnabled(false); return; }
    await request("POST", subscription.toJSON());
  } catch {
    // A temporary connection failure should preserve the user's opt-in.
    // Settings offers an explicit retry; the next app start also retries.
  }
}
