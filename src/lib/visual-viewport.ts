/** The keyboard shrinks the visual viewport on iOS, while vh/dvh and fixed
 * positioning still follow the layout viewport. Size the app to the visible
 * area; never compensate by adding keyboard-sized padding to the transcript. */
export function trackVisualViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const root = document.documentElement;
  let frame = 0;
  const update = () => {
    frame = 0;
    // Pinch zoom must magnify the existing layout, not reflow it underneath
    // the user's fingers. Resume tracking when they return to normal scale.
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
    root.style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
    // The home indicator's inset remains nonzero in iOS with the keyboard
    // open. It is already covered by the keyboard and must not become a gap.
    root.toggleAttribute("data-keyboard-open", window.innerHeight - viewport.height > 100);
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  update();
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  return () => {
    window.cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    root.style.removeProperty("--app-viewport-height");
    root.style.removeProperty("--app-viewport-top");
    root.removeAttribute("data-keyboard-open");
  };
}
