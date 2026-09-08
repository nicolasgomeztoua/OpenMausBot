import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(saved = false) {
  const storage = new Map(saved ? [["omb-web-push-enabled", "1"]] : []);
  const subscription = {
    endpoint: "https://web.push.apple.com/fixture",
    toJSON: () => ({ endpoint: "https://web.push.apple.com/fixture", keys: { p256dh: "fixture", auth: "fixture" } }),
    unsubscribe: vi.fn(async () => true),
  };
  const registered = { pushManager: {
    subscribe: vi.fn(async () => subscription),
    getSubscription: vi.fn(async () => subscription as typeof subscription | null),
  } };
  const serviceWorker = { register: vi.fn(async () => registered), ready: Promise.resolve(registered), getRegistration: vi.fn(async () => registered) };
  const requestPermission = vi.fn();
  const Notification = { permission: "default", requestPermission };
  const window = Object.assign(new EventTarget(), { isSecureContext: true, PushManager: class {}, Notification });
  const fetch = vi.fn(async () => Response.json({ publicKey: "fixture-public-key" }));
  vi.stubGlobal("window", window);
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("Notification", Notification);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("fetch", fetch);
  return { subscription, registered, serviceWorker, requestPermission, fetch, Notification, window };
}

describe("device notification opt-in", () => {
  it("prepares without prompting, and subscribes synchronously within the explicit action", async () => {
    const fixture = setup();
    const push = await import("./web-push");
    const prepared = await push.prepareWebPush();
    expect(fixture.registered.pushManager.subscribe).not.toHaveBeenCalled();
    expect(fixture.requestPermission).not.toHaveBeenCalled();
    const enabling = push.enableWebPush(prepared);
    expect(fixture.registered.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: "fixture-public-key" });
    await enabling;
    expect(push.webPushEnabled()).toBe(true);
    expect(fixture.fetch).toHaveBeenLastCalledWith("/api/notifications/push", expect.objectContaining({ method: "POST", body: JSON.stringify(fixture.subscription.toJSON()) }));
    expect(fixture.serviceWorker.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  });

  it("rolls back a browser subscription if the server cannot save it", async () => {
    const fixture = setup();
    const push = await import("./web-push");
    const prepared = await push.prepareWebPush();
    fixture.fetch.mockResolvedValueOnce(Response.json({ error: "Could not save" }, { status: 500 }));
    await expect(push.enableWebPush(prepared)).rejects.toThrow("Could not save");
    expect(fixture.subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(push.webPushEnabled()).toBe(false);
  });

  it("removes server delivery before reporting a device as disabled", async () => {
    const fixture = setup(true);
    const push = await import("./web-push");
    fixture.fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(push.disableWebPush()).rejects.toThrow("offline");
    expect(push.webPushEnabled()).toBe(true);
    expect(fixture.subscription.unsubscribe).not.toHaveBeenCalled();
    await push.disableWebPush();
    expect(fixture.fetch).toHaveBeenLastCalledWith("/api/notifications/push", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ endpoint: fixture.subscription.endpoint }) }));
    expect(fixture.subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(push.webPushEnabled()).toBe(false);
  });

  it("restores only an existing opt-in without a prompt or new subscription", async () => {
    const fixture = setup(true);
    const push = await import("./web-push");
    await push.restoreWebPush();
    expect(fixture.fetch).toHaveBeenCalledWith("/api/notifications/push", expect.objectContaining({ method: "POST" }));
    expect(fixture.registered.pushManager.subscribe).not.toHaveBeenCalled();
    expect(fixture.requestPermission).not.toHaveBeenCalled();
    fixture.fetch.mockRejectedValueOnce(new Error("offline"));
    await push.restoreWebPush();
    expect(push.webPushEnabled()).toBe(true);
    fixture.registered.pushManager.getSubscription.mockResolvedValueOnce(null);
    await push.restoreWebPush();
    expect(push.webPushEnabled()).toBe(false);
  });

  it("leaves notifications off by default and explains unsupported or denied permission", async () => {
    const fixture = setup();
    const push = await import("./web-push");
    await push.restoreWebPush();
    expect(fixture.serviceWorker.register).not.toHaveBeenCalled();
    fixture.Notification.permission = "denied";
    await expect(push.prepareWebPush()).rejects.toThrow(/blocked/);
    fixture.Notification.permission = "default";
    vi.stubGlobal("navigator", {});
    expect(push.webPushUnavailableReason()).toMatch(/Home Screen/);
    expect(fixture.requestPermission).not.toHaveBeenCalled();
  });

  it("allows retry after worker registration fails and broadcasts changed settings", async () => {
    const fixture = setup();
    const push = await import("./web-push");
    fixture.serviceWorker.register.mockRejectedValueOnce(new Error("worker unavailable"));
    await expect(push.prepareWebPush()).rejects.toThrow("worker unavailable");
    const prepared = await push.prepareWebPush();
    const listener = vi.fn();
    const stop = push.onWebPushChange(listener);
    await push.enableWebPush(prepared);
    expect(listener).toHaveBeenCalledOnce();
    stop();
    await push.disableWebPush();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not leave Settings waiting forever for an inactive worker", async () => {
    const fixture = setup();
    vi.useFakeTimers();
    fixture.serviceWorker.ready = new Promise(() => {});
    const push = await import("./web-push");
    const pending = expect(push.prepareWebPush()).rejects.toThrow("Notifications could not start");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });
});
