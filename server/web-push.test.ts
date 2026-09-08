import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { removeTempDir } from "./testing/cleanup.ts";
import { WebPushRegistry, isPushEndpoint } from "./web-push.ts";
import type { Notification } from "./notify.ts";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const frame: Notification = { kind: "done", botId: "bot-1", botName: "Atlas", threadId: "detached-1", title: "Atlas finished", body: "A synthetic result." };
const subscription = (name = "device") => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://web.push.apple.com/${name}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omb-push-test-"));
  dirs.push(dir);
  const file = join(dir, "push.json");
  const live = new Set(["session-1", "session-2"]);
  const sender = vi.fn<NonNullable<ConstructorParameters<typeof WebPushRegistry>[0]["sender"]>>(async () => ({ statusCode: 201, body: "", headers: {} }));
  const registry = new WebPushRegistry({ file, isLive: (id) => live.has(id), sender });
  return { file, live, sender, registry };
}

describe("paired-browser Web Push", () => {
  it("keeps VAPID identity and subscriptions across restarts in an owner-only file", async () => {
    const { registry, file, sender, live } = setup();
    const key = registry.publicKey();
    const sub = subscription();
    registry.subscribe("session-1", sub);
    const restored = new WebPushRegistry({ file, isLive: (id) => live.has(id), sender });
    expect(restored.publicKey()).toBe(key);
    expect(restored.subscribed("session-1", sub.endpoint)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    await restored.send(frame);
    expect(sender).toHaveBeenCalledOnce();
    const [target, payload, options] = sender.mock.calls[0];
    expect(target).toEqual(sub);
    expect(JSON.parse(payload)).toEqual({ title: frame.title, body: frame.body, botId: frame.botId, threadId: frame.threadId });
    // Exercise real encryption/VAPID construction without sending to a vendor.
    const request = webpush.generateRequestDetails(target, payload, options);
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(request.body?.toString()).not.toContain(frame.body);
  });

  it("rejects insecure, credentialed, local and lookalike endpoints", () => {
    const { registry } = setup();
    for (const endpoint of ["http://web.push.apple.com/a", "https://127.0.0.1/a", "https://example.com/a", "https://web.push.apple.com.evil.test/a", "https://user:pass@web.push.apple.com/a", "https://web.push.apple.com:444/a", "https://web.push.apple.com/a#x"]) {
      expect(isPushEndpoint(endpoint), endpoint).toBe(false);
      expect(() => registry.subscribe("session-1", { ...subscription(), endpoint })).toThrow();
    }
    expect(() => registry.subscribe("session-1", { ...subscription(), keys: { auth: "bad", p256dh: "bad" } })).toThrow();
  });

  it("prevents cross-session replacement and deletion, and stops after expiry or revocation", async () => {
    const { registry, sender, live } = setup();
    const sub = subscription();
    registry.subscribe("session-1", sub);
    expect(() => registry.subscribe("session-2", sub)).toThrow(/another paired session/);
    registry.unsubscribe("session-2", sub.endpoint);
    expect(registry.subscribed("session-1", sub.endpoint)).toBe(true);
    live.delete("session-1");
    await registry.send(frame);
    expect(sender).not.toHaveBeenCalled();
    expect(registry.subscribed("session-1", sub.endpoint)).toBe(false);
    expect(() => registry.subscribe("session-1", sub)).toThrow(/Pair/);
    registry.subscribe("session-2", sub);
    registry.unsubscribe("session-2");
    await registry.send(frame);
    expect(sender).not.toHaveBeenCalled();
  });

  it("removes expired push endpoints and contains transient provider errors", async () => {
    const { registry, sender } = setup();
    const sub = subscription();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.subscribe("session-1", sub);
    sender.mockRejectedValueOnce({ statusCode: 503 });
    await expect(registry.send(frame)).resolves.toBeUndefined();
    expect(registry.subscribed("session-1", sub.endpoint)).toBe(true);
    sender.mockRejectedValueOnce({ statusCode: 410 });
    await registry.send(frame);
    expect(registry.subscribed("session-1", sub.endpoint)).toBe(false);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining(sub.endpoint));
  });

  it("bounds subscriptions and preserves other bots while coalescing a busy device", async () => {
    const { registry, sender } = setup();
    const sub = subscription();
    registry.subscribe("session-1", sub);
    let release!: () => void;
    sender.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ statusCode: 201, body: "", headers: {} }); }));
    const first = registry.send(frame);
    await registry.send({ ...frame, body: "Old result" });
    await registry.send({ ...frame, botId: "bot-2", kind: "question", body: "Needs input" });
    await registry.send({ ...frame, body: "Latest result" });
    release();
    await first;
    expect(sender).toHaveBeenCalledTimes(3);
    const payloads = sender.mock.calls.map((args) => JSON.parse((args as unknown as [unknown, string])[1]));
    expect(payloads.map((payload) => payload.body)).toEqual([frame.body, "Latest result", "Needs input"]);
    registry.subscribe("session-1", subscription("two"));
    registry.subscribe("session-1", subscription("three"));
    expect(() => registry.subscribe("session-1", subscription("four"))).toThrow(/limit/);
  });

  it("does not overwrite unreadable persisted identity", () => {
    const { file } = setup();
    writeFileSync(file, "damaged");
    const registry = new WebPushRegistry({ file, isLive: () => true });
    expect(() => registry.publicKey()).toThrow(/could not be read/);
    expect(readFileSync(file, "utf8")).toBe("damaged");
  });
});
