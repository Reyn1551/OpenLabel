/**
 * Lazy wrappers for the Radix-backed controls.
 *
 * The app shell and the dashboard are on the Lighthouse critical path. Importing
 * the Radix bundle statically would put ~40 kB of dialog/dropdown/select/slider
 * code in the chunks that must load before first paint. These wrappers render the
 * visible trigger (or nothing, for a closed dialog) immediately and attach the
 * Radix behaviour once its chunk has loaded, so the controls never disappear and
 * the Radix bundle is fetched after the page has painted.
 *
 * The `lazy()` components are declared once at module scope on purpose. Calling
 * `lazy()` inside a component body creates a new component type on every render,
 * which makes React unmount and remount the subtree: a focused input inside a
 * dialog would lose focus and the dialog would flash its fallback on each
 * keystroke.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import type { DialogProps, MenuItem } from '@/ui/heavy';

const heavy = () => import('@/ui/heavy');

const Menu = lazy(() => heavy().then((m) => ({ default: m.Menu })));
const Tooltip = lazy(() => heavy().then((m) => ({ default: m.Tooltip })));
const Dialog = lazy(() => heavy().then((m) => ({ default: m.Dialog })));

export function LazyMenu({ trigger, items, label }: { trigger: ReactNode; items: MenuItem[]; label: string }) {
  return (
    <Suspense fallback={trigger}>
      <Menu trigger={trigger} items={items} label={label} />
    </Suspense>
  );
}

export function LazyTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Suspense fallback={children}>
      <Tooltip label={label}>{children}</Tooltip>
    </Suspense>
  );
}

export function LazyDialog(props: DialogProps) {
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}