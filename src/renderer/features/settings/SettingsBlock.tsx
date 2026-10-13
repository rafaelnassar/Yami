import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../shared/ui/card.tsx';

export function SettingsBlock({
  title,
  description,
  icon: Icon,
  children
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <Card className="space-y-0 border-border/90 bg-card/40">
      <CardHeader className="space-y-1.5 border-b border-border/70 pb-3">
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-[1.125rem] shrink-0 text-text-3" strokeWidth={1.75} aria-hidden />
          {title}
        </CardTitle>
        {description ? <CardDescription className="max-w-prose leading-relaxed">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4 pt-4">{children}</CardContent>
    </Card>
  );
}

/** Switch + hint row. */
export function SettingHint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="m-0 max-w-prose pl-1 type-caption">
      {children}
    </p>
  );
}
