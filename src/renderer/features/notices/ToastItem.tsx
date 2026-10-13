import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  KeyRound,
  RefreshCw,
  Settings,
  X,
  type LucideIcon
} from 'lucide-react';
import type { NoticeKind } from '../../../shared/contracts/dto.ts';
import type { MessageKey } from '../../../shared/i18n/catalog.ts';
import { useShallow } from 'zustand/react/shallow';
import { useHost } from '../../app/services-context.tsx';
import { useReducedMotion } from '../../shared/hooks/useReducedMotion.ts';
import { useT } from '../../shared/i18n/i18n-context.tsx';
import { FLOAT_LAYER_CLASS, toastMotion } from '../../shared/lib/motion.ts';
import { Button } from '../../shared/ui/button.tsx';
import { Spinner } from '../../shared/ui/spinner.tsx';
import { autoDismissMs, type Toast } from './notices-store.ts';
import { toastContent } from './toast-text.ts';

const KIND_META: Record<NoticeKind, { icon: LucideIcon; accent: string; surface: string; label: MessageKey }> = {
  error: { icon: AlertCircle, accent: 'text-err', surface: 'border-err/25 bg-err/12', label: 'ui.notices.kind.error' },
  warn: {
    icon: AlertTriangle,
    accent: 'text-warn',
    surface: 'border-warn/25 bg-warn/12',
    label: 'ui.notices.kind.warn'
  },
  success: {
    icon: CheckCircle2,
    accent: 'text-ok',
    surface: 'border-ok/25 bg-ok/12',
    label: 'ui.notices.kind.success'
  },
  info: { icon: Info, accent: 'text-info', surface: 'border-border-2 bg-surface-2', label: 'ui.notices.kind.info' }
};

/** After hover/focus ends, a toast stays at least this long (time to move the pointer away and back). */
const RESUME_MIN_MS = 1_500;

/**
 * Auto-dismiss that pauses while `paused` (hover/focus) and resumes with the
 * remaining time. `resetKey` restarts the countdown (toast content replaced).
 */
function useAutoDismiss(ms: number | null, paused: boolean, resetKey: number, dismiss: () => void): void {
  const remaining = useRef<number | null>(ms);
  const started = useRef(false);
  useEffect(() => {
    remaining.current = ms;
    started.current = false;
  }, [ms, resetKey]);
  useEffect(() => {
    if (paused || remaining.current === null) return;
    const delay = started.current ? Math.max(remaining.current, RESUME_MIN_MS) : remaining.current;
    started.current = true;
    const startedAt = Date.now();
    const timer = window.setTimeout(dismiss, delay);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current !== null) remaining.current = Math.max(0, delay - (Date.now() - startedAt));
    };
  }, [dismiss, ms, paused, resetKey]);
}

export interface ToastItemProps {
  readonly toast: Toast;
  readonly onDismiss: (id: string) => void;
  readonly onAction: (toast: Toast) => Promise<void>;
}

export const ToastItem = forwardRef<HTMLDivElement, ToastItemProps>(function ToastItem(
  { toast, onDismiss, onAction },
  ref
) {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const [acting, setActing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const runtimeBusy = useHost((state) => state.state?.runtime.busy === true);
  // Only the one tool a single-tool update toast shows, as primitives (host snapshots arrive 4×/s).
  const soleTool =
    toast.action?.type === 'runtime-update' && toast.action.tools.length === 1 ? (toast.action.tools[0] ?? null) : null;
  const versions = useHost(
    useShallow((state) => {
      const tool = soleTool ? state.state?.runtime.tools.find((item) => item.id === soleTool) : undefined;
      return { version: tool?.version ?? null, latestVersion: tool?.latestVersion ?? null };
    })
  );
  const tools = useMemo(() => (soleTool ? [{ id: soleTool, ...versions }] : []), [soleTool, versions]);
  const meta = KIND_META[toast.kind];
  const Icon = meta.icon;
  const { title, message } = toastContent(t, toast, tools);

  const dismissSelf = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);
  useAutoDismiss(autoDismissMs(toast), hovered || focused, toast.ts, dismissSelf);
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  const runAction = async (): Promise<void> => {
    if (acting) return;
    setActing(true);
    try {
      await onAction(toast);
    } finally {
      setActing(false);
    }
  };

  const action = toast.action;
  const busy = acting || (action?.type === 'runtime-update' && runtimeBusy);
  const actionLabel =
    action?.type === 'runtime-update'
      ? action.tools.length > 1
        ? t.t('ui.toast.runtimeUpdate.actionAll')
        : t.t('ui.toast.runtimeUpdate.action')
      : action?.type === 'vault-reset'
        ? t.t('ui.vault.reset')
        : t.t('ui.toast.openSettings');
  const busyLabel = action?.type === 'vault-reset' ? t.t('ui.vault.resetting') : t.t('ui.runtime.updating');
  const ActionIcon =
    action?.type === 'runtime-update' ? RefreshCw : action?.type === 'vault-reset' ? KeyRound : Settings;

  return (
    <motion.div
      ref={ref}
      layout={!reduceMotion}
      {...toastMotion(reduceMotion)}
      className={`pointer-events-auto w-full ${FLOAT_LAYER_CLASS}`}
    >
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
        role={toast.kind === 'error' ? 'alert' : 'status'}
        aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
        className="flex w-full items-start gap-3 rounded-lg border border-border-2 bg-surface p-3 shadow-panel sm:p-3.5"
      >
        <span
          className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${meta.surface}`}
          aria-hidden
        >
          <Icon className={`icon-inline ${meta.accent}`} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="min-w-0">
            <p className="type-caption m-0 font-medium uppercase tracking-[0.08em] text-text-4">{t.t(meta.label)}</p>
            <p className="type-heading m-0 mt-0.5 truncate leading-5" title={title}>
              {title}
            </p>
            {message ? (
              <p className="type-caption m-0 mt-1 line-clamp-3 break-words leading-5" title={message}>
                {message}
              </p>
            ) : null}
          </div>
          {action ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => void runAction()} disabled={busy}>
              {busy ? <Spinner /> : <ActionIcon strokeWidth={1.75} aria-hidden />}
              {busy ? busyLabel : actionLabel}
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onDismiss(toast.id)}
          aria-label={t.t('ui.toast.dismiss')}
          title={t.t('ui.toast.dismiss')}
          className="shrink-0 text-text-3 hover:text-text"
        >
          <X strokeWidth={1.75} aria-hidden />
        </Button>
      </div>
    </motion.div>
  );
});
