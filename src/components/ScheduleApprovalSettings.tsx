import { useRef, useState } from "react";

import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card, Switch } from "./SettingsPrimitives";

export function ScheduleApprovalSettings() {
  const { state, dispatch } = useStore();
  const enabled = state.config?.routines?.autoApprove === true;
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ routines: { autoApprove: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.schedules.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Card title={t("settings.schedules.title")} subtitle={t("settings.schedules.subtitle")}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.schedules.skip")}</div>
          <p id="schedule-approval-help" className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("settings.schedules.detail")}
          </p>
        </div>
        <Switch
          checked={enabled}
          aria-label={t("settings.schedules.skip")}
          aria-describedby="schedule-approval-help"
          disabled={saving || !state.config}
          onClick={() => void toggle()}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}
