import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

/** Native selection on phones, with the same readable skin as the dialog. */
export function SettingsSectionSelect(props: ComponentProps<"select">) {
  return (
    <div className="relative md:hidden">
      <select {...props} className="w-full appearance-none rounded-lg bg-control py-2 pl-3 pr-10 text-ink" />
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-secondary" />
    </div>
  );
}

export function Switch({
  checked,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "role" | "aria-checked"> & { checked: boolean }) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40",
        checked ? "bg-accent" : "bg-control",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all",
          checked ? "left-[21px]" : "left-[3px]",
        )}
      />
    </button>
  );
}

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      {title && <div className="text-[15px] font-medium text-ink">{title}</div>}
      {subtitle && <div className={title ? "mt-0.5 text-[13px] leading-relaxed text-ink-secondary" : "text-[13px] leading-relaxed text-ink-secondary"}>{subtitle}</div>}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </div>
  );
}

/** A command the user is meant to run, with one-click copy. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <button
        onClick={() => void copy()}
        aria-label="Copy command"
        className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
