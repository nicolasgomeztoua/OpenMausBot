// Real app + disposable fake engine. Install browsers with `pnpm exec
// playwright install chromium webkit`, then run `pnpm test:responsive`.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, webkit, type Locator, type Page } from "playwright";
import { createServer } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const { values } = parseArgs({ options: { browser: { type: "string", default: "chromium" }, output: { type: "string" } } });
assert(["chromium", "webkit"].includes(values.browser!));
const output = values.output ?? await mkdtemp(join(tmpdir(), "openmausbot-responsive-"));
await mkdir(output, { recursive: true });
const fixture = await launchVerificationServer();
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: Array<{ width: number; height: number; checks: string[] }> = [];

async function fits(locator: Locator) {
  await locator.evaluate(async (element) => {
    await Promise.all(element.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  const box = await locator.boundingBox();
  assert(box, "Element must be visible");
  const viewport = await locator.page().evaluate(() => ({ width: innerWidth, height: visualViewport!.height, top: visualViewport!.offsetTop }));
  assert(box.x >= -1 && box.x + box.width <= viewport.width + 1, `Horizontal overflow: ${JSON.stringify(box)}`);
  assert(box.y >= viewport.top - 1 && box.y + box.height <= viewport.top + viewport.height + 1, `Vertical overflow: ${JSON.stringify(box)}`);
}

async function noDocumentOverflow(page: Page) {
  const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
  assert(bounds.scrollWidth <= bounds.width + 1 && bounds.scrollHeight <= bounds.height + 1, JSON.stringify(bounds));
}

async function openDrawer(page: Page) {
  const button = page.getByRole("button", { name: "Open bot list", exact: true });
  if (await button.isVisible()) await button.click();
}

async function toolsMenu(page: Page, name: string) {
  await openDrawer(page);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

try {
  for (const name of ["Responsive Atlas", "Responsive Juniper"]) {
    await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  }
  const { bots } = await fetch(`${fixture.info.url}/api/bots`).then((r) => r.json()) as { bots: Array<{ id: string; name: string }> };
  const juniper = bots.find((bot) => bot.name === "Responsive Juniper")!;
  const atlas = bots.find((bot) => bot.name === "Responsive Atlas")!;
  for (const bot of [atlas, juniper, juniper]) {
    await runControlOmb(["send", "--bot", bot.id, "--text", "Responsive fixture: 1234567890. Verify a result in this isolated conversation.", "--url", fixture.info.url]);
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "20", "--url", fixture.info.url]);
  }
  for (let i = 0; i < 9; i++) {
    const response = await fetch(`${fixture.info.url}/api/bots/${juniper.id}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert(response.ok);
  }
  await runControlOmb(["new-channel", "--name", "Responsive team channel with a long name", "--members", `${atlas.id},${juniper.id}`, "--url", fixture.info.url]);
  ui = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } } });
  await ui.listen();
  browser = await (values.browser === "webkit" ? webkit : chromium).launch({ headless: true });
  for (const [width, height] of [[320, 568], [390, 844], [430, 932], [844, 390], [1280, 800]]) {
    console.log(`${values.browser}: checking ${width} × ${height}`);
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 768, hasTouch: width < 900 });
    await context.addInitScript(() => {
      localStorage.setItem("omb-email-gate", "skipped");
      localStorage.setItem("omb-analytics-opt-out", "1");
      // Desktop engines do not open an OS keyboard. Model the visual-only
      // resize separately from the page size, including iOS viewport panning.
      let height: number | undefined;
      const viewport = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperties(viewport, {
        height: { get: () => height ?? innerHeight, set: (value: number) => { height = value; } },
        width: { get: () => innerWidth },
      });
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const checks: string[] = [];
    try {
      await page.goto(ui.resolvedUrls!.local[0]!);
      const composer = page.locator("textarea").first();
      await composer.waitFor();
      await page.locator('.chat-header-actions button[aria-haspopup="dialog"][title*="Verification fixture"]').waitFor();
      await noDocumentOverflow(page);
      await fits(composer);
      await fits(page.locator(".chat-header-identity"));
      checks.push("chat, title and composer fit");

      await page.locator('.chat-header-actions button[aria-expanded]').first().click();
      const taskSearch = page.getByRole("textbox", { name: "Search tasks", exact: true });
      await taskSearch.waitFor();
      await fits(page.locator(".chat-header-popover"));
      await taskSearch.fill("no matching task");
      await page.getByText("Nothing matches “no matching task”", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      checks.push("task picker remains usable");

      await page.locator('.chat-header-actions button[aria-haspopup="dialog"]').click();
      await page.getByRole("dialog").waitFor();
      await fits(page.getByRole("dialog"));
      await page.keyboard.press("Escape");
      checks.push("model picker fits");

      await composer.fill("A multiline mobile draft\nSecond line\nThird line");
      if (width < 768) {
        assert(await composer.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)) >= 16);
        await page.evaluate(() => {
          Object.assign(visualViewport!, { height: 360, offsetTop: 24 });
          visualViewport!.dispatchEvent(new Event("resize"));
          visualViewport!.dispatchEvent(new Event("scroll"));
        });
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--app-viewport-height") === "360px");
        await fits(composer);
        await noDocumentOverflow(page);
        await page.screenshot({ path: join(output, `${values.browser}-${width}-keyboard.png`) });
        await page.locator('.chat-header-actions button[aria-expanded]').first().click();
        await fits(page.locator(".chat-header-popover"));
        await page.keyboard.press("Escape");
        await page.locator('.composer-pill button[aria-haspopup="menu"]').click();
        await fits(page.getByRole("menu"));
        await page.keyboard.press("Escape");
        await page.evaluate(() => { Object.assign(visualViewport!, { height: innerHeight, offsetTop: 0 }); visualViewport!.dispatchEvent(new Event("resize")); });
        await page.waitForFunction(() => !document.documentElement.hasAttribute("data-keyboard-open"));
      }
      await composer.fill("");
      checks.push("multiline draft and visual viewport resize");

      await page.locator(".chat-header-identity button").first().click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await fits(dialog);
      if (width < 768) await dialog.getByRole("combobox", { name: "Settings section" }).selectOption("identity");
      else await dialog.getByRole("button", { name: "Identity", exact: true }).click();
      await page.screenshot({ path: join(output, `${values.browser}-${width}-settings.png`) });
      await fits(dialog.getByRole("button", { name: "Close settings", exact: true }));
      await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
      checks.push("bot settings navigation and close");

      await page.getByTitle("Bot's computer", { exact: true }).click();
      const closeComputer = page.getByRole("button", { name: "Close computer", exact: true });
      await closeComputer.waitFor();
      await fits(page.locator("aside").filter({ has: closeComputer }));
      await closeComputer.click();
      await page.getByRole("button", { name: "Inspector", exact: true }).click();
      const closeInspector = page.getByRole("button", { name: "Close the Inspector", exact: true });
      await closeInspector.waitFor();
      await fits(page.locator("aside").filter({ has: closeInspector }));
      await closeInspector.click();
      checks.push("computer and inspector panels");

      await openDrawer(page);
      await page.getByRole("button", { name: "You", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      await dialog.waitFor();
      await fits(dialog);
      if (width < 768) await dialog.getByRole("combobox", { name: "Settings", exact: true }).selectOption("usage");
      else await dialog.getByRole("button", { name: "Usage", exact: true }).click();
      await dialog.locator("table tbody tr").first().waitFor();
      const columns = await dialog.locator("table tr").evaluateAll((rows) => rows.map((row) => [...row.children].map((cell) => cell.getBoundingClientRect().right)));
      assert(columns.length >= 4, "Header, two bots and totals must be present");
      for (const row of columns) assert.deepEqual(row, columns[0], "Usage columns must align across every row");
      await fits(dialog.locator("table"));
      await page.screenshot({ path: join(output, `${values.browser}-${width}-usage.png`) });
      await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
      checks.push("app settings and aligned usage columns");

      await openDrawer(page);
      await page.locator("[data-sidebar-group-row]").first().click();
      const skipSetup = page.getByRole("button", { name: "Skip for now", exact: true });
      if (await skipSetup.isVisible()) await skipSetup.click();
      await page.locator('.chat-header-actions select[aria-label]').waitFor();
      await fits(page.locator(".chat-header-identity"));
      await fits(page.locator("textarea").first());
      await noDocumentOverflow(page);
      await page.screenshot({ path: join(output, `${values.browser}-${width}-channel.png`) });
      checks.push("channel navigation, title and composer");

      await toolsMenu(page, "Automations");
      await page.getByRole("grid", { name: "Routine and call calendar" }).waitFor();
      if (width < 768) assert.equal(await page.getByRole("combobox", { name: "Schedule range" }).inputValue(), "1");
      await noDocumentOverflow(page);
      await page.getByLabel("Create an automation", { exact: true }).click();
      await page.getByRole("button", { name: "Create a scheduled task", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await fits(page.getByRole("dialog"));
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      checks.push("schedule and event creation");

      await toolsMenu(page, "Team map");
      await page.getByRole("heading", { name: "Team map", exact: true }).waitFor();
      await noDocumentOverflow(page);
      await page.screenshot({ path: join(output, `${values.browser}-${width}-team.png`) });
      checks.push("team map");
      assert.deepEqual(errors, []);
      results.push({ width, height, checks });
    } catch (error) {
      await page.screenshot({ path: join(output, `${values.browser}-${width}-failure.png`) }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ browser: values.browser, fixtureLog: fixture.info.logPath, results }, null, 2));
  console.log(JSON.stringify({ ok: true, output, results }));
} finally {
  await browser?.close();
  await ui?.close();
  await fixture.close();
}
