import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import * as SelectPrimitive from '@radix-ui/react-select';
import { X, Check, ChevronDown, Inbox } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { forwardRef, useId } from 'react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ buttons */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-fg)] hover:brightness-110 active:brightness-95 border border-transparent',
  secondary:
    'bg-[var(--surface-2)] text-[var(--fg)] border border-[var(--border)] hover:bg-[color-mix(in_oklab,var(--surface-2)_70%,var(--fg)_6%)]',
  ghost: 'bg-transparent text-[var(--fg)] border border-transparent hover:bg-[var(--surface-2)]',
  danger: 'bg-[var(--error)] text-[var(--danger-fg)] border border-transparent hover:brightness-110',
  success: 'bg-[var(--success)] text-[#04120a] border border-transparent hover:brightness-110',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-[13px] gap-1.5 rounded-md',
  md: 'h-10 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-12 px-5 text-base gap-2.5 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium transition-[filter,background-color] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-55',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-lg border transition-colors',
        active
          ? 'border-transparent bg-[var(--accent)] text-[var(--accent-fg)]'
          : cn(BUTTON_VARIANTS[variant], 'border-[var(--border)]'),
        size === 'sm' ? 'size-8' : size === 'lg' ? 'size-12' : 'size-10',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------- inputs */

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, hint, error, htmlFor, children, className }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--fg)]">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-[var(--muted)]">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs font-medium text-[var(--error)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--fg)]',
        'placeholder:text-[var(--muted)] disabled:opacity-60',
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-20 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]',
        'placeholder:text-[var(--muted)]',
        className,
      )}
      {...rest}
    />
  );
});

export function Checkbox({
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
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 rounded border-[var(--border)] accent-[var(--accent)]"
      />
      <div className="flex flex-col">
        <label htmlFor={id} className="text-sm text-[var(--fg)]">
          {label}
        </label>
        {description ? <span className="text-xs text-[var(--muted)]">{description}</span> : null}
      </div>
    </div>
  );
}

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

/* ------------------------------------------------------------------ feedback */

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'error';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-[var(--surface-2)] text-[var(--muted)] border-[var(--border)]',
    accent: 'bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-[var(--fg)] border-[color-mix(in_oklab,var(--accent)_40%,transparent)]',
    success: 'bg-[color-mix(in_oklab,var(--success)_16%,transparent)] text-[var(--success)] border-[color-mix(in_oklab,var(--success)_40%,transparent)]',
    warning: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)] border-[color-mix(in_oklab,var(--warning)_40%,transparent)]',
    error: 'bg-[color-mix(in_oklab,var(--error)_16%,transparent)] text-[var(--error)] border-[color-mix(in_oklab,var(--error)_40%,transparent)]',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('size-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

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

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4', className)}>{children}</div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-[var(--surface-2)] text-[var(--muted)]">
        {icon ?? <Inbox className="size-5" aria-hidden />}
      </div>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="max-w-sm text-xs text-[var(--muted)]">{description}</p>
      </div>
      {action}
    </div>
  );
}

/* -------------------------------------------------------------------- dialog */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[var(--scrim)] backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
            'rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl',
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
              <IconButton label="Close dialog" size="sm">
                <X className="size-4" aria-hidden />
              </IconButton>
            </DialogPrimitive.Close>
          </div>
          {children}
          {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ---------------------------------------------------------------------- menu */

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

/* ------------------------------------------------------------------- tooltip */

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root delayDuration={400}>
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
  );
}