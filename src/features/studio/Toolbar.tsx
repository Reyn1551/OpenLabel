import {
  Hand,
  Hexagon,
  MapPin,
  Maximize,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  Square,
  Trash2,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { ClassDef } from '@/core/types';
import { useStudio, type Tool } from '@/core/store';
import { IconButton, Tooltip } from '@/ui/primitives';
import { useT } from '@/ui/i18n';
import type { MessageKey } from '@/locales/en';

const TOOLS: { tool: Tool; key: string; icon: typeof MousePointer2; label: MessageKey }[] = [
  { tool: 'select', key: 'V', icon: MousePointer2, label: 'studio.tool.select' },
  { tool: 'box', key: 'B', icon: Square, label: 'studio.tool.box' },
  { tool: 'polygon', key: 'P', icon: Hexagon, label: 'studio.tool.polygon' },
  { tool: 'keypoint', key: 'K', icon: MapPin, label: 'studio.tool.keypoint' },
  { tool: 'freehand', key: 'F', icon: Pencil, label: 'studio.tool.freehand' },
  { tool: 'wand', key: 'W', icon: Wand2, label: 'studio.tool.wand' },
  { tool: 'pan', key: 'H', icon: Hand, label: 'studio.tool.pan' },
];

export function Toolbar({
  classes,
  onAddClass,
  onShowShortcuts,
}: {
  classes: ClassDef[];
  onAddClass: () => void;
  onShowShortcuts: () => void;
}) {
  const { t } = useT();
  const tool = useStudio((state) => state.tool);
  const setTool = useStudio((state) => state.setTool);
  const activeClassId = useStudio((state) => state.activeClassId);
  const setActiveClass = useStudio((state) => state.setActiveClass);
  const undo = useStudio((state) => state.undo);
  const redo = useStudio((state) => state.redo);
  const zoom = useStudio((state) => state.zoom);
  const setZoom = useStudio((state) => state.setZoom);
  const requestFit = useStudio((state) => state.requestFit);
  const selectedAnnotationId = useStudio((state) => state.selectedAnnotationId);
  const deleteAnnotation = useStudio((state) => state.deleteAnnotation);
  const histories = useStudio((state) => state.histories);
  const selectedImageId = useStudio((state) => state.selectedImageId);

  const history = selectedImageId ? histories[selectedImageId] : undefined;
  const canUndo = Boolean(history?.past.length);
  const canRedo = Boolean(history?.future.length);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div role="toolbar" aria-label={t('studio.tools')} className="flex items-center gap-1">
        {TOOLS.map((entry) => {
          const Icon = entry.icon;
          return (
            <Tooltip key={entry.tool} label={`${t(entry.label)} (${entry.key})`}>
              <IconButton
                label={t(entry.label)}
                active={tool === entry.tool}
                onClick={() => setTool(entry.tool)}
                aria-keyshortcuts={entry.key}
              >
                <Icon className="size-4" aria-hidden />
              </IconButton>
            </Tooltip>
          );
        })}
      </div>

      <div className="mx-1 h-6 w-px bg-[var(--border)]" aria-hidden />

      <div
        role="group"
        aria-label={t('studio.activeClass')}
        className="flex max-w-full items-center gap-1 overflow-x-auto py-0.5"
      >
        {classes.map((cls, index) => (
          <button
            key={cls.id}
            type="button"
            aria-pressed={activeClassId === cls.id}
            onClick={() => setActiveClass(cls.id)}
            title={index < 9 ? `${cls.name} (${index + 1})` : cls.name}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ${
              activeClassId === cls.id
                ? 'border-transparent text-[#0b0d12]'
                : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--fg)] hover:border-[var(--muted)]'
            }`}
            style={activeClassId === cls.id ? { backgroundColor: cls.color } : undefined}
          >
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: activeClassId === cls.id ? '#0b0d12' : cls.color }}
            />
            {cls.name}
          </button>
        ))}
        <IconButton label={t('studio.addClass')} size="sm" onClick={onAddClass}>
          <Plus className="size-4" aria-hidden />
        </IconButton>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <IconButton label={t('studio.undo')} onClick={() => void undo()} disabled={!canUndo} aria-keyshortcuts="Control+Z">
          <Undo2 className="size-4" aria-hidden />
        </IconButton>
        <IconButton
          label={t('studio.redo')}
          onClick={() => void redo()}
          disabled={!canRedo}
          aria-keyshortcuts="Control+Shift+Z"
        >
          <Redo2 className="size-4" aria-hidden />
        </IconButton>
        <div className="mx-1 h-6 w-px bg-[var(--border)]" aria-hidden />
        <IconButton label={t('studio.zoomOut')} onClick={() => setZoom(zoom / 1.25)} aria-keyshortcuts="-">
          <ZoomOut className="size-4" aria-hidden />
        </IconButton>
        <span aria-live="off" className="w-12 text-center font-mono text-xs text-[var(--muted)]">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton label={t('studio.zoomIn')} onClick={() => setZoom(zoom * 1.25)} aria-keyshortcuts="+">
          <ZoomIn className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={t('studio.zoomFit')} onClick={requestFit} aria-keyshortcuts="0">
          <Maximize className="size-4" aria-hidden />
        </IconButton>
        <IconButton
          label={t('studio.deleteSelected')}
          onClick={() => selectedAnnotationId && void deleteAnnotation(selectedAnnotationId)}
          disabled={!selectedAnnotationId}
        >
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={t('studio.shortcuts')} onClick={onShowShortcuts} aria-keyshortcuts="?">
          <span aria-hidden className="text-xs font-semibold">?</span>
        </IconButton>
      </div>
    </div>
  );
}