/**
 * The small set of building blocks every screen uses. Flat, hairline-ruled
 * and quiet, so the data and the few status colours carry the page.
 */

import { AlertTriangle, CheckCircle2, CircleSlash, Clock3, Loader2, OctagonAlert, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ApiError } from "../lib/api";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Buttons and fields
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  primary: "bg-ink text-page hover:opacity-90 disabled:opacity-40",
  secondary: "border border-rule-strong text-ink hover:bg-sunken disabled:opacity-40",
  ghost: "text-ink-2 hover:text-ink hover:bg-sunken disabled:opacity-40",
  danger: "border border-rule-strong text-critical-text hover:bg-sunken disabled:opacity-40",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md"; busy?: boolean; icon?: ReactNode }
>(function Button({ variant = "secondary", size = "md", busy, icon, className, children, disabled, ...props }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-[4px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap",
        size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
        buttonStyles[variant],
        className,
      )}
      {...props}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

const fieldBase =
  "w-full rounded-[4px] border border-rule-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-ink focus:outline-none disabled:opacity-50";

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="text-[12px] text-critical-text">{error}</span> : hint ? <span className="text-[12px] text-ink-3">{hint}</span> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cx(fieldBase, "h-9", className)} {...props} />;
});

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(fieldBase, "h-9 pr-8", className)} {...props}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(fieldBase, "py-2 leading-relaxed", className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Tone = "good" | "warning" | "critical" | "neutral" | "info";

const toneStyles: Record<Tone, { mark: string; text: string; Icon: typeof CheckCircle2 }> = {
  good: { mark: "bg-good", text: "text-good-text", Icon: CheckCircle2 },
  warning: { mark: "bg-warning", text: "text-warning-text", Icon: AlertTriangle },
  critical: { mark: "bg-critical", text: "text-critical-text", Icon: OctagonAlert },
  neutral: { mark: "bg-ink-3", text: "text-ink-2", Icon: CircleSlash },
  info: { mark: "bg-series-1", text: "text-ink-2", Icon: Clock3 },
};

/** A status word with a coloured square beside it. Colour never carries the meaning alone. */
export function Status({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-[12px] font-medium", toneStyles[tone].text, className)}>
      <span className={cx("size-2 shrink-0 rounded-[1px]", toneStyles[tone].mark)} aria-hidden />
      {children}
    </span>
  );
}

export function StatusIcon({ tone, className }: { tone: Tone; className?: string }) {
  const { Icon, text } = toneStyles[tone];
  return <Icon className={cx("size-4 shrink-0", text, className)} aria-hidden />;
}

/** Code chip for activity ids and references, in the drawing-register mono face. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[12px] text-ink-2", className)}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PageHeader({ eyebrow, title, meta, actions }: { eyebrow?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
      <div className="min-w-0">
        {eyebrow ? <div className="eyebrow mb-1.5">{eyebrow}</div> : null}
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        {meta ? <div className="mt-1.5 text-[13px] text-ink-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("min-w-0", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-rule pb-2">
        <h2 className="eyebrow !text-ink-2">{title}</h2>
        {aside ? <div className="text-[12px] text-ink-3">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A labelled figure. `value` is the headline, `note` explains it. */
export function Figure({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-[22px] font-semibold leading-none tracking-[-0.01em]">
        {tone ? <StatusIcon tone={tone} /> : null}
        <span className="truncate">{value}</span>
      </div>
      {note ? <div className="mt-1.5 text-[12px] text-ink-2">{note}</div> : null}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-[6px] border border-rule bg-surface", className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, className, align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" }) {
  return (
    <th className={cx("border-b border-rule-strong px-3 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3 whitespace-nowrap", align === "right" && "text-right", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className, align = "left", colSpan }: { children?: ReactNode; className?: string; align?: "left" | "right"; colSpan?: number }) {
  return <td colSpan={colSpan} className={cx("border-b border-rule px-3 py-2.5 align-top", align === "right" && "text-right tabular", className)}>{children}</td>;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-[13px] text-ink-3" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[6px] border border-dashed border-rule-strong px-6 py-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      {children ? <div className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-2">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Something went wrong";
  const details = error instanceof ApiError && Array.isArray(error.details) ? (error.details as unknown[]) : [];
  return (
    <div className="rounded-[4px] border border-critical/40 bg-[var(--critical-wash)] px-3 py-2 text-[13px] text-critical-text" role="alert">
      {message}
      {details.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {details.slice(0, 8).map((d, i) => (
            <li key={i}>{typeof d === "string" ? d : (d as { message?: string }).message ?? JSON.stringify(d)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function Dialog({ open, onClose, title, children, width = "max-w-lg" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => event.target === ref.current && onClose()}
      className={cx("m-auto w-[calc(100%-32px)] rounded-[6px] border border-rule bg-surface p-0 text-ink shadow-[0_24px_60px_-20px_rgb(0_0_0/0.35)] backdrop:bg-black/30", width)}
    >
      <div className="flex items-center justify-between border-b border-rule px-5 py-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <button onClick={onClose} className="rounded p-1 text-ink-3 hover:text-ink" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <div className="px-5 py-4">{children}</div>
    </dialog>
  );
}
