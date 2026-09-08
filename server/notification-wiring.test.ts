// Notification policy has pure unit coverage; this pins the production wiring
// from a real failed routine turn through RoutineManager and the server's SSE
// stream. A generic `done` frame for the same failure would produce two desktop
// notifications, so the marker PATCH below is an ordering barrier before the
// exact emitted set is asserted.
import { spawn, type ChildProcess } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";
let deliveryFile: string;

function pushSubscription(name: string) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return { endpoint: `https://web.push.apple.com/${name}`, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

interface BotPatchBody {
  name?: string;
  notifications?: boolean;
  modelSelection?: { instanceId: string; model: string };
}

interface RoutineBody {
  name: string;
  prompt: string;
  botId: string;
  runOn: "maus";
  schedule: { type: "once"; at: number };
}

const api = async (
  method: string,
  path: string,
  body?: BotPatchBody | RoutineBody | Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; cookie: string | null }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] ?? null };
};

async function pair(label: string) {
  const opened = await api("POST", "/api/auth/pairing", { label, scopes: ["client"] });
  expect(opened.status).toBe(200);
  const paired = await api("POST", "/api/auth/pair", { code: opened.body.code, label, cookie: true });
  expect(paired.status).toBe(200);
  expect(paired.cookie).toBeTruthy();
  return { cookie: paired.cookie! };
}

const subscriptions = () => JSON.parse(readFileSync(join(home, ".openmausbot", "web-push.json"), "utf8")).subscriptions;

posixOnly("routine failure notification wiring", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-notifications-e2e-"));
    deliveryFile = join(home, "push-deliveries.jsonl");
    writeFileSync(deliveryFile, "");
    // Stub the outbound vendor transport in this child only. The actual
    // notification policy, HTTP authorization and subscription store run as
    // production code, with no network delivery or production test hook.
    const preload = join(home, "push-transport.mjs");
    writeFileSync(preload, `import webpush from ${JSON.stringify(new URL("../node_modules/web-push/src/index.js", import.meta.url).href)};\nimport { appendFileSync } from 'node:fs';\nwebpush.sendNotification = async (subscription, payload) => { appendFileSync(${JSON.stringify(deliveryFile)}, JSON.stringify({ endpoint: subscription.endpoint, payload: JSON.parse(payload) }) + '\\n'); return { statusCode: 201, headers: {}, body: '' }; };\n`);
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grokAgent",
            // fail-after-text streams a partial answer before failing: with a
            // NON-empty reply, only the routine-failed/done dedup suppresses
            // the generic done — exit-early would pass on the empty-reply
            // rule alone and leave the dedup guard untested.
            environment: { FAKE_ACP_MODE: "fail-after-text" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

    child = spawn(process.execPath, ["--import", preload, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("authorizes a paired client, isolates ownership, rejects cross-origin writes and cleans up on logout", async () => {
    const first = await pair("First fixture device");
    const second = await pair("Second fixture device");
    try {
      const sub = pushSubscription("http-fixture");
      expect((await api("GET", "/api/notifications/push")).status).toBe(400);
      expect((await api("GET", "/api/notifications/push", undefined, { "x-forwarded-for": "203.0.113.10" })).status).toBe(403);
      const key = await api("GET", "/api/notifications/push", undefined, first);
      expect(key.status).toBe(200);
      expect(Object.keys(key.body)).toEqual(["publicKey"]);
      expect((await api("POST", "/api/notifications/push", sub, { ...first, origin: "https://evil.example" })).status).toBe(403);
      expect((await api("POST", "/api/notifications/push", { ...sub, endpoint: "https://127.0.0.1/" }, first)).status).toBe(400);
      expect((await api("POST", "/api/notifications/push", sub, first)).status).toBe(200);
      expect((await api("POST", "/api/notifications/push", sub, second)).status).toBe(400);
      expect((await api("DELETE", "/api/notifications/push", { endpoint: sub.endpoint }, second)).status).toBe(200);
      expect(subscriptions()).toHaveLength(1);
      expect((await api("POST", "/api/auth/logout", undefined, first)).status).toBe(200);
      expect(subscriptions()).toEqual([]);
    } finally {
      await api("POST", "/api/auth/logout", undefined, first);
      await api("POST", "/api/auth/logout", undefined, second);
    }
  });

  it(
    "emits one routine-failed notification for the detached task and no generic done notification",
    async () => {
      const device = await pair("Routine notification fixture");
      const subscription = pushSubscription("routine-fixture");
      expect((await api("POST", "/api/notifications/push", subscription, device)).status).toBe(200);
      const listed = await api("GET", "/api/bots");
      const bot = listed.body.bots[0];
      expect(
        (
          await api("PATCH", `/api/bots/${bot.id}`, {
            name: "Routine Scout",
            notifications: true,
            modelSelection: { instanceId: "grok", model: "fake-model" },
          })
        ).status,
      ).toBe(200);

      const created = await api("POST", "/api/routines", {
        name: "Broken nightly report",
        prompt: "Prepare the report",
        botId: bot.id,
        runOn: "maus",
        schedule: { type: "once", at: Date.now() + 60_000 },
      });
      expect(created.status).toBe(201);

      const stream = await openSse(`${BASE}/api/events`);
      try {
        await stream.until((frame) => frame.kind === "hello");
        const launched = await api("POST", `/api/routines/${created.body.routine.id}/run`);
        expect(launched.status).toBe(201);

        const frame = await stream.until(
          (candidate) =>
            candidate.kind === "notify" &&
            candidate.notification?.kind === "routine-failed" &&
            candidate.notification?.botId === bot.id,
          30_000,
        );
        expect(frame.notification).toMatchObject({
          kind: "routine-failed",
          botId: bot.id,
          title: "Routine Scout's routine failed",
        });
        expect(frame.notification.threadId).not.toBe(bot.threadId);
        expect(frame.notification.body).toContain("Broken nightly report");

        const receipts = await api("GET", "/api/routines");
        const receipt = receipts.body.runs.find((run: { id: string }) => run.id === launched.body.run.id);
        expect(receipt).toMatchObject({
          status: "failed",
          botId: bot.id,
          threadId: frame.notification.threadId,
        });

        // A unique bot patch is an SSE ordering barrier: by the time it is
        // observed, every notification emitted by the failed turn is already
        // in `frames`, including an accidental generic `done` duplicate.
        expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Failure observed" })).status).toBe(200);
        await stream.until(
          (candidate) => candidate.kind === "bot" && candidate.bot?.id === bot.id && candidate.bot?.name === "Failure observed",
        );

        expect(
          stream.frames
            .filter(
              (candidate) =>
                candidate.kind === "notify" && candidate.notification?.threadId === frame.notification.threadId,
            )
            .map((candidate) => candidate.notification.kind),
        ).toEqual(["routine-failed"]);
        const deliveries = readFileSync(deliveryFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        expect(deliveries).toEqual([{ endpoint: subscription.endpoint, payload: {
          title: frame.notification.title,
          body: frame.notification.body.slice(0, 300),
          botId: bot.id,
          threadId: frame.notification.threadId,
        } }]);
      } finally {
        stream.close();
        await api("DELETE", `/api/routines/${created.body.routine.id}`);
        await api("POST", "/api/auth/logout", undefined, device);
      }
    },
    60_000,
  );
});
