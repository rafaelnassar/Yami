import { useId } from 'react';
import { Label } from './label.tsx';
import { Switch } from './switch.tsx';
import { cn } from '../lib/utils.ts';

export interface LabeledSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  id?: string;
  ariaLabel?: string;
  /** id of an element describing the switch (hint text). */
  describedBy?: string;
  disabled?: boolean;
  className?: string;
}

/** Domain switch row: shadcn Switch + Label. */
export function LabeledSwitch({
  checked,
  onCheckedChange,
  label,
  id,
  ariaLabel,
  describedBy,
  disabled = false,
  className = ''
}: LabeledSwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;

  return (
    <div
      className={cn(
        'inline-flex min-h-11 items-center gap-3 rounded-md px-1 text-left',
        disabled && 'opacity-50',
        className
      )}
    >
      <Switch
        id={switchId}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-describedby={describedBy}
      />
      <Label
        htmlFor={switchId}
        className={cn('cursor-pointer', checked ? 'text-foreground' : 'text-text-3', disabled && 'cursor-not-allowed')}
      >
        {label}
      </Label>
    </div>
  );
}
