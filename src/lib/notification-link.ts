import type { NotificationTarget } from "./notify";

const PENDING_KEY = "omb-notification-target";

export function notificationTargetFromHash(hash: string): NotificationTarget | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const botId = params.get("bot");
  const threadId = params.get("thread");
  if (!botId || !threadId || ![botId, threadId].every((id) => /^[\w-]{1,128}$/.test(id))) return null;
  return { botId, threadId };
}

/** Preserve a notification destination if this browser first needs pairing. */
export function captureNotificationLink() {
  const target = notificationTargetFromHash(location.hash);
  if (target) {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(target)); } catch { /* the hash still works for a paired browser */ }
  }
}

export function pendingNotificationTarget(): NotificationTarget | null {
  const current = notificationTargetFromHash(location.hash);
  if (current) return current;
  try {
    const stored = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
    return stored && typeof stored.botId === "string" && typeof stored.threadId === "string"
      ? notificationTargetFromHash(new URLSearchParams({ bot: stored.botId, thread: stored.threadId }).toString()) : null;
  } catch { return null; }
}

export function clearNotificationLink() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* optional persistence */ }
  if (notificationTargetFromHash(location.hash)) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
}
