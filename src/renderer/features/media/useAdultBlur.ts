/**
 * The single adult-content blur hook used wherever media is shown (library,
 * workspace, preview, tray). Driven by `settings.adultBlur`; revealing is per
 * media item and resets when the item changes.
 */
import { useEffect, useState } from 'react';
import { useSettings } from '../../app/services-context.tsx';
import { hintKey, shouldBlurMedia } from '../../shared/lib/adult-content.ts';

export interface AdultBlur {
  readonly isAdult: boolean;
  readonly blurred: boolean;
  readonly reveal: () => void;
}

export function useAdultBlur(hints: ReadonlyArray<string | null | undefined>): AdultBlur {
  const enabled = useSettings((state) => state.settings.adultBlur);
  const identity = hintKey(hints);
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const isAdult = shouldBlurMedia(enabled, hints);

  useEffect(() => {
    setRevealedFor((current) => (current === identity ? current : null));
  }, [identity, enabled]);

  return {
    isAdult,
    blurred: isAdult && revealedFor !== identity,
    reveal: () => setRevealedFor(identity)
  };
}
