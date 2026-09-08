// Opt-in, paired-browser delivery. Notification policy still belongs to
// notify.ts; this module only stores subscriptions and transports its frames.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import webpush, { type PushSubscription, type RequestOptions, type SendResult } from "web-push";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { Notification } from "./notify.ts";

const base64url = (bytes: number) => z.string().regex(/^[\w-]+$/).refine((value) => Buffer.from(value, "base64url").length === bytes);

/** Subscription URLs cause outbound requests. Accept the browser vendors'
 * HTTPS push services, never an arbitrary URL supplied by a paired client. */
export function isPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash && (
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "updates.push.services.mozilla.com" ||
      /^[a-z0-9-]+\.push\.apple\.com$/.test(url.hostname) ||
      /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname)
    );
  } catch { return false; }
}

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine(isPushEndpoint, "Unsupported push service"),
  keys: z.object({ p256dh: base64url(65), auth: base64url(16) }),
});

const storedSchema = z.object({
  version: z.literal(1),
  keys: z.object({ publicKey: base64url(65), privateKey: base64url(32) }),
  subscriptions: z.array(z.object({ sessionId: z.string(), subscription: pushSubscriptionSchema })).max(100),
});
type Stored = z.infer<typeof storedSchema>;
type Sender = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<SendResult>;

export class WebPushRegistry {
  private readonly file: string;
  private readonly isLive: (id: string) => boolean;
  private readonly sender: Sender;
  private stored: Stored | null = null;
  private loadFailed = false;
  private readonly pending = new Map<string, { running: boolean; latest: Map<string, Notification> }>();

  constructor(options: { file: string; isLive: (id: string) => boolean; sender?: Sender }) {
    this.file = options.file;
    this.isLive = options.isLive;
    this.sender = options.sender ?? webpush.sendNotification;
    if (existsSync(this.file)) {
      try { this.stored = storedSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))); }
      catch { this.loadFailed = true; }
    }
  }

  private persist(next = this.stored) {
    writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.stored = next;
  }

  publicKey(): string {
    if (this.loadFailed) throw new Error("Saved notification settings could not be read.");
    if (!this.stored) {
      this.persist({ version: 1, keys: webpush.generateVAPIDKeys(), subscriptions: [] });
    }
    return this.stored!.keys.publicKey;
  }

  subscribed(sessionId: string, endpoint: string): boolean {
    return Boolean(this.stored?.subscriptions.some((entry) => entry.sessionId === sessionId && entry.subscription.endpoint === endpoint));
  }

  subscribe(sessionId: string, value: unknown) {
    const subscription = pushSubscriptionSchema.parse(value);
    if (!this.isLive(sessionId)) throw new Error("Pair this browser before enabling notifications.");
    this.publicKey();
    const stored = this.stored!;
    // Expired pairings cannot keep a browser subscription alive or prevent a
    // newly paired instance of that browser from registering it again.
    const subscriptions = stored.subscriptions.filter((entry) => this.isLive(entry.sessionId));
    const owner = subscriptions.find((entry) => entry.subscription.endpoint === subscription.endpoint);
    if (owner && owner.sessionId !== sessionId) throw new Error("This browser subscription belongs to another paired session.");
    if (!owner) {
      if (subscriptions.length >= 100 || subscriptions.filter((entry) => entry.sessionId === sessionId).length >= 3) {
        throw new Error("Notification device limit reached. Remove an existing subscription first.");
      }
    }
    this.persist({ ...stored, subscriptions: [...subscriptions.filter((entry) => entry !== owner), { sessionId, subscription }] });
  }

  unsubscribe(sessionId: string, endpoint?: string) {
    if (!this.stored) return;
    const before = this.stored.subscriptions.length;
    this.stored.subscriptions = this.stored.subscriptions.filter((entry) => entry.sessionId !== sessionId || (endpoint !== undefined && entry.subscription.endpoint !== endpoint));
    if (this.stored.subscriptions.length !== before) this.persist();
  }

  /** A slow push provider cannot block the bot or create an unbounded queue.
   * Keep the latest waiting notice per bot, with at most 32 bots waiting on
   * any one device. One bot's result must not overwrite another's question. */
  async send(notification: Notification): Promise<void> {
    if (!this.stored) return;
    await Promise.all(this.stored.subscriptions.map(async ({ sessionId, subscription }) => {
      if (!this.isLive(sessionId)) { this.unsubscribe(sessionId); return; }
      const endpoint = subscription.endpoint;
      const pending = this.pending.get(endpoint) ?? { running: false, latest: new Map<string, Notification>() };
      pending.latest.set(notification.botId, notification);
      if (pending.latest.size > 32) pending.latest.delete(pending.latest.keys().next().value!);
      this.pending.set(endpoint, pending);
      if (pending.running) return;
      pending.running = true;
      try {
        while (pending.latest.size && this.isLive(sessionId) && this.subscribed(sessionId, endpoint)) {
          const next = pending.latest.values().next().value!;
          pending.latest.delete(next.botId);
          // Only the destination and bounded human-facing copy leave this
          // server, encrypted by the standard Web Push library for the device.
          const payload = JSON.stringify({ title: next.title.slice(0, 160), body: next.body.slice(0, 300), botId: next.botId, threadId: next.threadId });
          try {
            await this.sender(subscription, payload, {
              vapidDetails: { subject: "https://github.com/milind-soni/OpenMausBot", ...this.stored!.keys },
              TTL: 3600, timeout: 10_000, urgency: next.kind === "done" ? "normal" : "high",
              topic: createHash("sha256").update(next.botId).digest("base64url").slice(0, 32),
            });
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) this.unsubscribe(sessionId, endpoint);
            // Do not log the endpoint, encrypted request or provider response:
            // subscription URLs themselves are private device capabilities.
            console.warn(`[web-push] Delivery failed${typeof status === "number" ? ` (${status})` : ""}.`);
          }
        }
      } finally {
        this.pending.delete(endpoint);
      }
    }));
  }
}
