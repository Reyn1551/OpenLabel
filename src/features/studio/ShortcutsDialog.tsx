import { Dialog } from '@/ui/primitives';
import { useT } from '@/ui/i18n';

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'V', action: 'Select tool' },
  { keys: 'B', action: 'Rectangle tool' },
  { keys: 'P', action: 'Polygon tool' },
  { keys: 'K', action: 'Keypoint tool' },
  { keys: 'F', action: 'Freehand tool' },
  { keys: 'W', action: 'Smart select (magic wand)' },
  { keys: 'H or Space + drag', action: 'Pan' },
  { keys: '1 – 9', action: 'Switch active class' },
  { keys: 'Enter (canvas)', action: 'Keyboard placement / close polygon' },
  { keys: 'Arrows', action: 'Nudge selected annotation (Shift = 10 px)' },
  { keys: 'Ctrl/Cmd + Z', action: 'Undo' },
  { keys: 'Ctrl/Cmd + Shift + Z', action: 'Redo' },
  { keys: 'Delete', action: 'Delete selected annotation' },
  { keys: '+ / −', action: 'Zoom in / out' },
  { keys: '0', action: 'Fit image to screen' },
  { keys: '[ / ]', action: 'Previous / next image' },
  { keys: '?', action: 'This help' },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useT();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('studio.shortcutsTitle')}
      description={t('studio.shortcutsDescription')}
      wide
    >
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('studio.shortcutsTitle')}</caption>
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-wide text-[var(--muted)]">
            <th scope="col" className="py-2">
              {t('studio.shortcut.action')}
            </th>
            <th scope="col" className="py-2 text-right">
              {t('studio.shortcut.keys')}
            </th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((row) => (
            <tr key={row.keys} className="border-b border-[var(--border)] last:border-0">
              <td className="py-2 pr-4">{row.action}</td>
              <td className="py-2 text-right">
                <kbd className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-xs">
                  {row.keys}
                </kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}