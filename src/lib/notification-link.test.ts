import { afterEach, describe, expect, it, vi } from "vitest";
import { captureNotificationLink, clearNotificationLink, notificationTargetFromHash, pendingNotificationTarget } from "./notification-link";

afterEach(() => vi.unstubAllGlobals());
describe("notification deep links", () => {
  it("accepts only a bounded bot and exact thread destination", () => {
    expect(notificationTargetFromHash("#bot=bot-1&thread=routine-2")).toEqual({ botId: "bot-1", threadId: "routine-2" });
    for (const hash of ["", "#bot=bot-1", "#bot=../escape&thread=x", "#bot=x&thread=https://example.com", `#bot=${"x".repeat(129)}&thread=x`]) {
      expect(notificationTargetFromHash(hash)).toBeNull();
    }
  });
  it("preserves the target through pairing and consumes it once", () => {
    const saved = new Map();
    vi.stubGlobal("sessionStorage", { setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key), removeItem: (key: string) => saved.delete(key) });
    vi.stubGlobal("location", { hash: "#bot=bot-1&thread=detached-2", pathname: "/", search: "" });
    vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
    captureNotificationLink();
    location.hash = "";
    expect(pendingNotificationTarget()).toEqual({ botId: "bot-1", threadId: "detached-2" });
    clearNotificationLink();
    expect(pendingNotificationTarget()).toBeNull();
    location.hash = "#bot=bot-1&thread=detached-2";
    clearNotificationLink();
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
  });
});
