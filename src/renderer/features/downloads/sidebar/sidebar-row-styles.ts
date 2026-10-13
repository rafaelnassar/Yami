import { cn } from '../../../shared/lib/utils.ts';

/** Main click target: no ghost hover — row wrapper owns background. */
export const SIDEBAR_ROW_MAIN =
  'flex min-h-11 w-full min-w-0 cursor-pointer items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left font-normal outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus';

/** Side icon / menu trigger: light wash on hover, visible when row is active or hovered. */
export function sidebarSideActionClass(reveal: boolean): string {
  return cn(
    'sidebar-row-action inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border-transparent bg-transparent text-text-4 shadow-none transition-colors duration-150',
    'hover:!bg-white/8 hover:!text-text-2 active:!bg-white/10',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
    'data-[state=open]:!bg-white/10 data-[state=open]:text-text-2 data-[state=open]:opacity-100 data-[state=open]:pointer-events-auto',
    reveal
      ? 'pointer-events-auto opacity-100'
      : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
  );
}

/** Trailing meta (date, counts) — hide on row hover so actions fit. */
export const SIDEBAR_ROW_META_HIDE =
  'shrink-0 font-mono text-2xs tabular-nums text-text-4 transition-opacity duration-150 group-hover:pointer-events-none group-hover:opacity-0';
