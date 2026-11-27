/**
 * Small shared building blocks. All text is rendered through React, which
 * escapes it; nothing here accepts HTML.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type Tone = "ok" | "info" | "warn" | "bad" | "neutral";

interface PageProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Shows an in-app Back button. Telegram's native Back button is managed by App. */
  readonly onBack?: () => void;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

export function Page({ title, subtitle, onBack, actions, footer, children }: PageProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Moves focus to the new screen's heading so keyboard and screen reader
    // users start at the top after navigation.
    headingRef.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <section className="page">
      <header className="page-header">
        {onBack !== undefined && (
          <button type="button" className="icon-button" onClick={onBack} aria-label="Back">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div className="page-title">
          <h2 ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
          {subtitle !== undefined && <p className="subtitle">{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="page-actions">{actions}</div>}
      </header>
      <div className="page-body">{children}</div>
      {footer !== undefined && <footer className="page-footer">{footer}</footer>}
    </section>
  );
}

/** The gear that opens Settings; shared by every screen that offers it. */
export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="icon-button" onClick={onClick} aria-label="Settings and diagnostics">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.1-1.4-.1-1.4 2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.4-1.4L14.2 3h-4l-.4 2.7a7.6 7.6 0 0 0-2.4 1.4l-2.4-1-2 3.4 2 1.6-.1 1.4.1 1.4-2 1.6 2 3.4 2.4-1c.7.6 1.5 1 2.4 1.4l.4 2.7h4l.4-2.7c.9-.3 1.7-.8 2.4-1.4l2.4 1 2-3.4-2-1.6Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** A status label with a coloured dot. The text carries the meaning; colour only repeats it. */
export function StatusChip({ tone, label, pulse = false }: { tone: Tone; label: string; pulse?: boolean }) {
  return (
    <span className={`chip chip-${tone}`}>
      <span className={pulse ? "dot dot-pulse" : "dot"} aria-hidden="true" />
      <span className="chip-label">{label}</span>
    </span>
  );
}

export function Notice({
  tone,
  title,
  children,
  alert = false,
}: {
  tone: Tone;
  title?: string;
  children: ReactNode;
  alert?: boolean;
}) {
  return (
    <div className={`notice notice-${tone}`} role={alert ? "alert" : undefined}>
      {title !== undefined && <p className="notice-title">{title}</p>}
      <div className="notice-body">{children}</div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children !== undefined && <div className="empty-body">{children}</div>}
      {action !== undefined && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function SkeletonList({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="skeleton-list" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId();
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h3 id={id}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal bottom sheet. Focus moves into it, Tab stays inside, Escape closes,
 * and focus returns to the element that opened it.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("h2")?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || panel === null) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("sheet-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sheet-open");
      opener?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={id} ref={panelRef}>
        <div className="sheet-grip" aria-hidden="true" />
        <h2 id={id} tabIndex={-1} className="sheet-title">
          {title}
        </h2>
        <div className="sheet-body">{children}</div>
        {footer !== undefined && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet
      title={title}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <div className="button-row">
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? "button button-destructive" : "button button-primary"}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      {children}
      {error !== null && (
        <Notice tone="bad" alert>
          {error}
        </Notice>
      )}
    </Sheet>
  );
}

/** Runs one async action at a time and exposes whether it is in flight. */
export function useBusy(): [boolean, <T>(action: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await action();
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return [busy, run];
}

/** Re-renders periodically so relative times stay current. */
export function useNow(intervalMs: number, now: () => number): number {
  const [value, setValue] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => setValue(now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, now]);
  return value;
}
