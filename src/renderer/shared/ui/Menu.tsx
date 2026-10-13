/**
 * Domain menu button built on shadcn DropdownMenu.
 * Keeps the MenuItemSpec API used across composer, sidebar and video controls.
 */
import { Fragment, type ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { Button, type ButtonProps } from './button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './dropdown-menu.tsx';

export interface MenuItemSpec {
  readonly id: string;
  readonly label: string;
  /** Secondary line under the label. */
  readonly description?: string;
  readonly kind?: 'action' | 'radio' | 'heading';
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onSelect?: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  /** Keeps the menu open after selection (e.g. expanding a sub-list). */
  readonly keepOpen?: boolean;
  readonly indent?: boolean;
}

export interface MenuButtonProps {
  readonly items: readonly MenuItemSpec[];
  readonly menuLabel: string;
  readonly triggerLabel: string;
  readonly triggerContent: ReactNode;
  readonly triggerClassName: string;
  readonly title?: string;
  readonly width?: number;
  /** Horizontal alignment of the menu relative to the trigger. */
  readonly align?: 'start' | 'end';
  readonly onOpenChange?: (open: boolean) => void;
  readonly triggerSize?: ButtonProps['size'];
  readonly triggerVariant?: ButtonProps['variant'];
}

type Segment =
  | { readonly type: 'heading'; readonly item: MenuItemSpec; readonly showSeparator: boolean }
  | { readonly type: 'action'; readonly item: MenuItemSpec }
  | { readonly type: 'radio-group'; readonly items: readonly MenuItemSpec[] };

function segmentItems(items: readonly MenuItemSpec[]): Segment[] {
  const segments: Segment[] = [];
  let radioBuffer: MenuItemSpec[] = [];

  const flushRadios = (): void => {
    if (radioBuffer.length === 0) return;
    segments.push({ type: 'radio-group', items: radioBuffer });
    radioBuffer = [];
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === 'heading') {
      flushRadios();
      segments.push({ type: 'heading', item, showSeparator: index > 0 });
      continue;
    }
    if (item.kind === 'radio') {
      radioBuffer.push(item);
      continue;
    }
    flushRadios();
    segments.push({ type: 'action', item });
  }
  flushRadios();
  return segments;
}

function ItemBody({ item }: { item: MenuItemSpec }) {
  const hasDescription = Boolean(item.description);
  return (
    <>
      {item.icon ? (
        <span
          className={cn(
            'inline-flex size-[1.125rem] shrink-0 items-center justify-center self-start text-text-3',
            hasDescription ? 'mt-0.5' : 'self-center'
          )}
          aria-hidden
        >
          {item.icon}
        </span>
      ) : null}
      {hasDescription ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate leading-5 font-medium">{item.label}</span>
          <span className="block truncate text-xs leading-4 text-muted-foreground">{item.description}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate self-center leading-5">{item.label}</span>
      )}
      {item.trailing ? <span className="ml-auto shrink-0 self-center">{item.trailing}</span> : null}
    </>
  );
}

export function MenuButton({
  items,
  menuLabel,
  triggerLabel,
  triggerContent,
  triggerClassName,
  title,
  width = 188,
  align = 'end',
  onOpenChange,
  triggerSize,
  triggerVariant = 'ghost'
}: MenuButtonProps) {
  const segments = segmentItems(items);

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          aria-label={triggerLabel}
          title={title ?? triggerLabel}
          className={cn(
            'border-transparent bg-transparent shadow-none',
            triggerClassName,
            'data-[state=open]:bg-accent data-[state=open]:text-secondary-foreground',
            triggerClassName.includes('sidebar-row-action') &&
              'data-[state=open]:bg-transparent data-[state=open]:text-inherit'
          )}
        >
          {triggerContent}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        aria-label={menuLabel}
        style={{ width }}
        className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto"
      >
        {segments.map((segment, segmentIndex) => {
          if (segment.type === 'heading') {
            return (
              <Fragment key={segment.item.id}>
                {segment.showSeparator ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel>{segment.item.label}</DropdownMenuLabel>
              </Fragment>
            );
          }
          if (segment.type === 'radio-group') {
            const value = segment.items.find((item) => item.checked)?.id;
            return (
              <DropdownMenuRadioGroup
                key={`radio-${segmentIndex}`}
                value={value}
                onValueChange={(next) => {
                  segment.items.find((item) => item.id === next)?.onSelect?.();
                }}
              >
                {segment.items.map((item) => (
                  <DropdownMenuRadioItem
                    key={item.id}
                    value={item.id}
                    disabled={item.disabled}
                    className={cn(item.indent && 'pl-10')}
                    onSelect={(event) => {
                      if (item.keepOpen) event.preventDefault();
                    }}
                  >
                    <ItemBody item={item} />
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            );
          }
          return (
            <DropdownMenuItem
              key={segment.item.id}
              disabled={segment.item.disabled}
              danger={segment.item.danger}
              className={cn(segment.item.indent && 'pl-4')}
              onSelect={(event) => {
                if (segment.item.disabled) return;
                if (segment.item.keepOpen) event.preventDefault();
                segment.item.onSelect?.();
              }}
            >
              <ItemBody item={segment.item} />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
