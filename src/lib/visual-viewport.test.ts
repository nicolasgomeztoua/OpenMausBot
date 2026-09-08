import { afterEach, describe, expect, it, vi } from "vitest";
import { trackVisualViewport } from "./visual-viewport";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const values = new Map<string, string>();
  const attributes = new Set<string>();
  const root = {
    style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key) },
    toggleAttribute: (key: string, on: boolean) => on ? attributes.add(key) : attributes.delete(key),
    removeAttribute: (key: string) => attributes.delete(key),
  };
  let pending: FrameRequestCallback | undefined;
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    visualViewport: viewport, innerHeight: 844,
    requestAnimationFrame: vi.fn((fn: FrameRequestCallback) => { pending = fn; return 1; }),
    cancelAnimationFrame: vi.fn(() => { pending = undefined; }),
  }));
  const flush = () => { const callback = pending; pending = undefined; callback?.(0); };
  return { viewport, values, attributes, flush };
}

describe("visual viewport", () => {
  it("follows keyboard opening, viewport panning, and dismissal without accumulating padding", () => {
    const { viewport, values, attributes, flush } = setup();
    const stop = trackVisualViewport();
    expect(values.get("--app-viewport-height")).toBe("844px");
    Object.assign(viewport, { height: 480, offsetTop: 42 });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    flush();
    expect(values.get("--app-viewport-height")).toBe("480px");
    expect(values.get("--app-viewport-top")).toBe("42px");
    expect(attributes.has("data-keyboard-open")).toBe(true);
    Object.assign(viewport, { height: 844, offsetTop: 0 });
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(values.get("--app-viewport-height")).toBe("844px");
    expect(values.get("--app-viewport-top")).toBe("0px");
    expect(attributes.has("data-keyboard-open")).toBe(false);
    stop();
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(values.size).toBe(0);
  });

  it("preserves the layout during pinch zoom and handles orientation changes afterwards", () => {
    const { viewport, values, flush } = setup();
    const stop = trackVisualViewport();
    Object.assign(viewport, { scale: 2, height: 422, offsetTop: 100 });
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(values.get("--app-viewport-height")).toBe("844px");
    Object.assign(viewport, { scale: 1, height: 390, offsetTop: 0 });
    window.innerHeight = 390;
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(values.get("--app-viewport-height")).toBe("390px");
    stop();
  });

  it("falls back to CSS sizing without the API", () => {
    vi.stubGlobal("window", {});
    expect(() => trackVisualViewport()()).not.toThrow();
  });
});
