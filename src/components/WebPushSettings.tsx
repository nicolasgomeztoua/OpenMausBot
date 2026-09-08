import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Card } from "./SettingsPrimitives";
import { disableWebPush, enableWebPush, onWebPushChange, prepareWebPush, webPushEnabled, webPushUnavailableReason } from "@/lib/web-push";

export function WebPushSettings() {
  const [enabled, setEnabled] = useState(webPushEnabled);
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof prepareWebPush>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const reason = webPushUnavailableReason();
  const desktop = Boolean(window.ogb && !window.ogb.remoteClient?.active);

  useEffect(() => onWebPushChange(() => setEnabled(webPushEnabled())), []);
  useEffect(() => {
    if (desktop || reason) return;
    let active = true;
    setError("");
    void prepareWebPush().then((value) => { if (active) setPrepared(value); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not prepare notifications."); });
    return () => { active = false; };
  }, [desktop, reason, retry]);

  if (desktop) return null;
  return (
    <Card title="Notifications on this device" subtitle="Get alerts when an agent finishes or needs your input, even with this web app closed. Each agent's notification setting still applies.">
      {reason ? <p className="text-[13px] text-ink-secondary">{reason}</p> : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || (!enabled && !prepared)}
            onClick={() => {
              setBusy(true);
              setError("");
              const action = enabled ? disableWebPush() : enableWebPush(prepared!);
              void action.then(() => setEnabled(webPushEnabled()))
                .catch((cause) => setError(cause instanceof Error ? cause.message : "Notification settings could not be changed."))
                .finally(() => setBusy(false));
            }}
            className="flex min-h-11 items-center gap-2 rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink hover:bg-control disabled:opacity-40"
          >
            <Bell size={16} />{busy ? "Saving…" : enabled ? "Disable notifications" : prepared ? "Enable notifications" : "Preparing notifications…"}
          </button>
          <span role="status" className="text-[12px] text-ink-secondary">{enabled ? "Enabled on this device" : "Off on this device"}</span>
        </div>
      )}
      {error && <div className="mt-3 text-[13px] text-danger" role="alert">{error}<button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 underline">Retry</button></div>}
    </Card>
  );
}
