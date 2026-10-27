/**
 * Radix-backed primitives, split from `primitives.tsx` so the app shell and the
 * dashboard (the Lighthouse critical path) do not load the Radix bundle until a
 * dialog, menu, or other heavy control is actually used. `primitives.tsx`
 * re-exports everything here, so existing import sites keep working; the app
 * shell lazy-loads this chunk instead of importing it statically.
 */
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------- switch */

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm text-[var(--fg)]">
          {label}
        </label>
        {description ? <span className="text-xs text-[var(--muted)]">{description}</span> : null}
      </div>
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full border border-[var(--border)] transition-colors',
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--surface-2)]',
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'block size-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5.5' : 'translate-x-1',
          )}
        />
      </SwitchPrimitive.Root>
    </div>
  );
}

/* ------------------------------------------------------------------- slider */

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  format,
  disabled,
  onCommit,
}: {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="font-mono text-xs text-[var(--muted)]">{format ? format(value) : value}</span>
      </div>
      <SliderPrimitive.Root
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([next]) => onChange(next)}
        onValueCommit={([next]) => onCommit?.(next)}
        aria-label={label}
        className="relative flex h-6 w-full touch-none items-center"
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow rounded-full bg-[var(--surface-2)]">
          <SliderPrimitive.Range className="absolute h-full rounded-full bg-[var(--accent)]" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block size-4 rounded-full border-2 border-[var(--accent)] bg-[var(--surface)] shadow" />
      </SliderPrimitive.Root>
    </div>
  );
}

/* ------------------------------------------------------------------- select */

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={label}
        className={cn(
          'inline-flex h-10 w-full min-w-0 items-center justify-between gap-2 overflow-hidden whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm',
          'data-[placeholder]:text-[var(--muted)]',
          className,
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 text-[var(--muted)]" aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="relative flex cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-[var(--surface-2)]"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2">
                  <Check className="size-4 text-[var(--accent)]" aria-hidden />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/* ----------------------------------------------------------------- progress */

export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <ProgressPrimitive.Root
      value={Math.round(Math.min(1, Math.max(0, value)) * 100)}
      aria-label={label}
      className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]"
    >
      <ProgressPrimitive.Indicator
        className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200"
        style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

/* ------------------------------------------------------------------- dialog */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
            'rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--elev-3)]',
            wide ? 'max-w-3xl' : 'max-w-lg',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="space-y-1">
              <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-[13px] text-[var(--muted)]">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close dialog"
                className="grid size-8 place-items-center rounded-lg border border-transparent text-[var(--fg)] hover:bg-[var(--surface-2)]"
              >
                <X className="size-4" aria-hidden />
              </button>
            </DialogPrimitive.Close>
          </div>
          {children}
          {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* --------------------------------------------------------------------- menu */

export interface MenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}

export function Menu({ trigger, items, label }: { trigger: ReactNode; items: MenuItem[]; label: string }) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align="end"
          sideOffset={6}
          aria-label={label}
          className="z-50 min-w-52 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl"
        >
          {items.map((item) => (
            <MenuPrimitive.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={cn(
                'flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none',
                'data-[highlighted]:bg-[var(--surface-2)] data-[disabled]:opacity-50',
                item.destructive && 'text-[var(--error)]',
              )}
            >
              {item.icon}
              {item.label}
            </MenuPrimitive.Item>
          ))}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/* --------------------------------------------------------------------- tabs */

export const Tabs = TabsPrimitive.Root;
export const TabsList = ({ children, label }: { children: ReactNode; label: string }) => (
  <TabsPrimitive.List
    aria-label={label}
    className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1"
  >
    {children}
  </TabsPrimitive.List>
);
export const TabsTrigger = ({ value, children }: { value: string; children: ReactNode }) => (
  <TabsPrimitive.Trigger
    value={value}
    className="rounded-md px-3 py-1.5 text-[13px] font-medium text-[var(--muted)] data-[state=active]:bg-[var(--surface)] data-[state=active]:text-[var(--fg)] data-[state=active]:shadow-sm"
  >
    {children}
  </TabsPrimitive.Trigger>
);
export const TabsContent = TabsPrimitive.Content;

/* ------------------------------------------------------------------ tooltip */

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={400}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-50 max-w-64 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs shadow-lg"
          >
            {label}
            <TooltipPrimitive.Arrow className="fill-[var(--surface)]" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
