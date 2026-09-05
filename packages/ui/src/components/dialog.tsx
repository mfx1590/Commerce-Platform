'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: it is the accessible name of the dialog (`aria-labelledby`). */
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Escape and overlay click close the dialog. Set false for a blocking confirmation. */
  dismissible?: boolean;
  closeLabel?: string;
  className?: string;
}

/**
 * Modal dialog with a focus trap: focus moves into the panel on open, Tab and Shift+Tab cycle
 * inside it, Escape closes, and focus returns to the trigger afterwards. Rendered in place rather
 * than in a portal so it inherits the ThemeProvider's CSS variables.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  dismissible = true,
  closeLabel = 'Close',
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // Move focus in on open, restore it on close, and keep the page behind from scrolling.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    restoreFocusTo.current = active instanceof HTMLElement ? active : null;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusTo.current?.focus();
    };
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && dismissible) {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    const nodes = focusable.length > 0 ? focusable : [panel];
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;

    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={onKeyDown}>
      <div
        data-testid="dialog-overlay"
        className="absolute inset-0 bg-foreground/50"
        onClick={dismissible ? close : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description == null ? undefined : descriptionId}
        tabIndex={-1}
        className={cn(
          'relative z-10 m-4 w-full max-w-lg rounded-lg border border-border bg-card p-6 text-card-foreground shadow-xl focus-visible:outline-none',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-lg font-semibold leading-tight">
              {title}
            </h2>
            {description == null ? null : (
              <p id={descriptionId} className="text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={close}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {children == null ? null : <div className="mt-4">{children}</div>}
        {footer == null ? null : <DialogFooter>{footer}</DialogFooter>}
      </div>
    </div>
  );
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-6 flex items-center justify-end gap-2', className)} {...props} />;
}
