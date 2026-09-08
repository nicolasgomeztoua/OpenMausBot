import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
function setup() {
  const listeners = new Map();
  const showNotification = vi.fn(async () => {});
  const clients = { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => {}) };
  runInNewContext(source, { URL, URLSearchParams, self: { addEventListener: (name, fn) => listeners.set(name, fn), skipWaiting: vi.fn(), clients, registration: { showNotification }, location: { origin: "https://app.example" } } });
  const dispatch = async (name, event) => {
    let pending;
    listeners.get(name)({ ...event, waitUntil: (promise) => { pending = promise; } });
    await pending;
  };
  return { dispatch, showNotification, clients };
}

describe("push service worker", () => {
  it("shows a visible, coalesced alert with its exact destination", async () => {
    const { dispatch, showNotification } = setup();
    await dispatch("push", { data: { json: () => ({ title: "Atlas finished", body: "Fixture result", botId: "atlas", threadId: "routine-task" }) } });
    expect(showNotification).toHaveBeenCalledWith("Atlas finished", expect.objectContaining({ body: "Fixture result", tag: "openmausbot:atlas", data: { botId: "atlas", threadId: "routine-task" } }));
  });
  it("always displays a fallback for missing or invalid payloads", async () => {
    const { dispatch, showNotification } = setup();
    await dispatch("push", { data: { json: () => { throw new Error("invalid"); } } });
    expect(showNotification).toHaveBeenCalledWith("OpenMausBot", expect.objectContaining({ data: null }));
  });
  it("opens the exact task after a closed-app notification", async () => {
    const { dispatch, clients } = setup();
    const close = vi.fn();
    await dispatch("notificationclick", { notification: { close, data: { botId: "atlas", threadId: "detached-task" } } });
    expect(close).toHaveBeenCalledOnce();
    expect(clients.openWindow).toHaveBeenCalledWith("https://app.example/#bot=atlas&thread=detached-task");
  });
  it("reuses a same-origin app, with a new window if that tab is closing", async () => {
    const { dispatch, clients } = setup();
    const focus = vi.fn(async () => {});
    const navigate = vi.fn(async () => ({ focus }));
    clients.matchAll.mockResolvedValue([{ url: "https://app.example/", navigate }]);
    const event = { notification: { close: vi.fn(), data: { botId: "atlas", threadId: "task" } } };
    await dispatch("notificationclick", event);
    expect(navigate).toHaveBeenCalledWith("https://app.example/#bot=atlas&thread=task");
    expect(focus).toHaveBeenCalledOnce();
    expect(clients.openWindow).not.toHaveBeenCalled();
    navigate.mockRejectedValueOnce(new Error("tab closed"));
    await dispatch("notificationclick", event);
    expect(clients.openWindow).toHaveBeenCalledOnce();
  });
  it("cannot navigate to a URL smuggled into notification data", async () => {
    const { dispatch, clients } = setup();
    await dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "https://evil.example/", botId: "../evil", threadId: "x" } } });
    expect(clients.openWindow).toHaveBeenCalledWith("https://app.example/");
  });
});
