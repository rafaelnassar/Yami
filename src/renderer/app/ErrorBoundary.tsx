/**
 * Error boundary with a recover button. Used at the root and around each feature
 * panel so one broken panel does not blank the whole window.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useT } from '../shared/i18n/i18n-context.tsx';
import { Button } from '../shared/ui/button.tsx';

interface BoundaryProps {
  readonly children: ReactNode;
  /** Layout of the fallback: a full window or an inline panel. */
  readonly variant?: 'root' | 'panel';
  /** Changing it resets the boundary (e.g. another conversation was opened). */
  readonly resetKey?: string | number | null;
}

interface BoundaryState {
  readonly error: Error | null;
  readonly resetKey: string | number | null | undefined;
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Diagnostic only; main collects renderer console output in its log.
    // eslint-disable-next-line no-console -- the console is the renderer's only diagnostic channel into main's log
    console.error('[renderer] panel crashed', error, info.componentStack);
  }

  private readonly recover = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback variant={this.props.variant ?? 'panel'} onRecover={this.recover} />;
  }
}

function ErrorFallback({ variant, onRecover }: { variant: 'root' | 'panel'; onRecover: () => void }) {
  const t = useT();
  return (
    <div
      role="alert"
      // Read by the launch smoke test (src/main/app/smoke-test.ts): a crashed panel fails the run.
      data-yami-error-boundary={variant}
      className={`flex flex-col items-center justify-center gap-3 px-6 text-center ${variant === 'root' ? 'h-screen w-screen bg-bg' : 'min-h-48 w-full flex-1 py-10'}`}
    >
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-err/30 bg-err/10 text-err">
        <AlertTriangle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      </span>
      <p className="type-heading m-0">{t.t('ui.errorBoundary.title')}</p>
      <p className="type-caption m-0 max-w-sm">{t.t('ui.errorBoundary.message')}</p>
      <Button type="button" variant="secondary" onClick={onRecover} className="mt-1 gap-2 px-4">
        <RotateCcw className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        {t.t('ui.errorBoundary.recover')}
      </Button>
    </div>
  );
}
