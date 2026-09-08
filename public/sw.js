// Push only. Do not cache the app or authenticated API responses: pairing,
// updates, and private conversation data keep their normal network behavior.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function targetUrl(value) {
  if (!value || ![value.botId, value.threadId].every((id) => typeof id === "string" && /^[\w-]{1,128}$/.test(id))) return null;
  const url = new URL("/", self.location.origin);
  url.hash = new URLSearchParams({ bot: value.botId, thread: value.threadId }).toString();
  return url.href;
}

self.addEventListener("push", (event) => {
  let data;
  try { data = event.data?.json(); } catch { /* still display a visible fallback */ }
  const url = targetUrl(data);
  event.waitUntil(self.registration.showNotification(
    url && typeof data.title === "string" ? data.title.slice(0, 160) : "OpenMausBot",
    {
      body: url && typeof data.body === "string" ? data.body.slice(0, 300) : "An agent has an update for you.",
      icon: "/app-icon-512.png",
      tag: url ? `openmausbot:${data.botId}` : "openmausbot:update",
      data: url ? { botId: data.botId, threadId: data.threadId } : null,
    },
  ));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = targetUrl(event.notification.data) ?? new URL("/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      try {
        const navigated = await existing.navigate(url);
        if (navigated) { await navigated.focus(); return; }
      } catch { /* a closing tab cannot prevent opening the destination */ }
    }
    await self.clients.openWindow(url);
  })());
});
