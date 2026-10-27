/**
 * Lazy wrappers for the Radix-backed controls.
 *
 * The app shell and the dashboard are on the Lighthouse critical path. Importing
 * the Radix bundle statically would put ~40 kB of dialog/dropdown/select/slider
 * code in the chunks that must load before first paint. These wrappers render the
 * visible trigger (or nothing, for a closed dialog) immediately and attach the
 * Radix behaviour once its chunk has loaded, so the controls never disappear and
 * the Radix bundle is fetched after the page has painted.
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import type { DialogProps, MenuItem } from '@/ui/heavy';

const heavy = () => import('@/ui/heavy');

export function LazyMenu({ trigger, items, label }: { trigger: ReactNode; items: MenuItem[]; label: string }) {
  const Menu = lazy(
    () =>
      heavy().then((m) => ({
        default: m.Menu as ComponentType<{ trigger: ReactNode; items: MenuItem[]; label: string }>,
      })),
  );
  return (
    <Suspense fallback={trigger}>
      <Menu trigger={trigger} items={items} label={label} />
    </Suspense>
  );
}

export function LazyTooltip({ label, children }: { label: string; children: ReactNode }) {
  const Tooltip = lazy(() => heavy().then((m) => ({ default: m.Tooltip as ComponentType<{ label: string; children: ReactNode }> })));
  return (
    <Suspense fallback={children}>
      <Tooltip label={label}>{children}</Tooltip>
    </Suspense>
  );
}

export function LazyDialog(props: DialogProps) {
  const Dialog = lazy(() => heavy().then((m) => ({ default: m.Dialog as ComponentType<DialogProps> })));
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}
