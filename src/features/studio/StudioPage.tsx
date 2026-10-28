import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ImagePlus, Images, PanelLeft, PanelRight, Upload } from 'lucide-react';
import type { MessageKey } from '@/locales/en';
import type { Geometry } from '@/core/types';
import { useStudio, type Tool } from '@/core/store';
import { filesFromDataTransfer } from '@/core/import';
import { directoryPickerSupport, pickImageFolder } from '@/core/fs-access';
import { useT, useAnnouncer, useToast } from '@/ui/i18n';
import { Button, EmptyState, IconButton, Spinner } from '@/ui/primitives';
import { Dialog } from '@/ui/heavy';
import { CanvasStage } from './CanvasStage';
import { ImageRail } from './ImageRail';
import { InspectorPanel } from './InspectorPanel';
import { Toolbar } from './Toolbar';
import { ClassDialog } from './ClassDialog';
import { ShortcutsDialog } from './ShortcutsDialog';
import { useImageBitmap } from './useThumb';

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  b: 'box',
  p: 'polygon',
  k: 'keypoint',
  f: 'freehand',
  w: 'wand',
  h: 'pan',
};

/**
 * Moves the selection by one image and returns whether it moved.
 *
 * Shared by the keyboard handler and the prev/next buttons so both agree on the
 * bounds. `A`/`D` are the primary keys (home row, left hand, on every layout);
 * `[`/`]` still work as an alternative.
 */
function stepImage(delta: number): boolean {
  const { images, selectedImageId, selectImage } = useStudio.getState();
  const index = images.findIndex((item) => item.id === selectedImageId);
  if (index < 0) return false;
  const next = index + delta;
  if (next < 0 || next >= images.length) return false;
  selectImage(images[next].id);
  return true;
}


export function StudioPage() {
  const { projectId = '' } = useParams();
  const { t } = useT();
  const { notify } = useToast();
  const { announce, region } = useAnnouncer();
  const load = useStudio((state) => state.load);
  const unload = useStudio((state) => state.unload);
  const project = useStudio((state) => state.project);
  const images = useStudio((state) => state.images);
  const annotations = useStudio((state) => state.annotations);
  const selectedImageId = useStudio((state) => state.selectedImageId);
  const selectedAnnotationId = useStudio((state) => state.selectedAnnotationId);
  const tool = useStudio((state) => state.tool);
  const zoom = useStudio((state) => state.zoom);
  const pan = useStudio((state) => state.pan);
  const activeClassId = useStudio((state) => state.activeClassId);
  const showAnnotations = useStudio((state) => state.showAnnotations);
  const showConfidence = useStudio((state) => state.showConfidence);
  const predictions = useStudio((state) => state.predictions);
  const fitNonce = useStudio((state) => state.fitNonce);
  const loading = useStudio((state) => state.loading);
  const addClass = useStudio((state) => state.addClass);
  const importImages = useStudio((state) => state.importImages);
  const addAnnotation = useStudio((state) => state.addAnnotation);
  const updateAnnotation = useStudio((state) => state.updateAnnotation);
  const deleteAnnotation = useStudio((state) => state.deleteAnnotation);
  const selectAnnotation = useStudio((state) => state.selectAnnotation);
  const beginEdit = useStudio((state) => state.beginEdit);

  const image = useMemo(() => images.find((item) => item.id === selectedImageId) ?? null, [images, selectedImageId]);
  const imageIndex = useMemo(() => images.findIndex((item) => item.id === selectedImageId), [images, selectedImageId]);
  const canPrev = imageIndex > 0;
  const canNext = imageIndex >= 0 && imageIndex < images.length - 1;
  const { bitmap, loading: bitmapLoading, error: bitmapError } = useImageBitmap(selectedImageId);
  const currentAnnotations = useMemo(
    () => (selectedImageId ? annotations[selectedImageId] ?? [] : []),
    [annotations, selectedImageId],
  );
  const currentPredictions = useMemo(
    () => (selectedImageId ? predictions[selectedImageId] ?? [] : []),
    [predictions, selectedImageId],
  );

  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showClassDialog, setShowClassDialog] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'images' | 'inspector' | null>(null);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('openlabel.rail') !== 'closed');
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem('openlabel.inspector') !== 'closed');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleRail = useCallback(() => {
    setRailOpen((open) => {
      localStorage.setItem('openlabel.rail', open ? 'closed' : 'open');
      return !open;
    });
  }, []);
  const toggleInspector = useCallback(() => {
    setInspectorOpen((open) => {
      localStorage.setItem('openlabel.inspector', open ? 'closed' : 'open');
      return !open;
    });
  }, []);

  useEffect(() => {
    void load(projectId);
    return () => unload();
  }, [projectId, load, unload]);

  useEffect(() => {
    if (project) document.title = `${project.name} · OpenLabel`;
  }, [project]);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      try {
        const result = await importImages(files);
        if (result) {
          if (result.added.length > 0) {
            notify({ title: t('studio.uploaded', { count: result.added.length }), tone: 'success' });
          }
          if (result.skipped > 0) {
            notify({ title: t('studio.uploadSkipped', { count: result.skipped }), tone: 'info' });
          }
          for (const error of result.errors.slice(0, 3)) {
            notify({ title: error.name, description: error.message, tone: 'error' });
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [importImages, notify, t],
  );

  const openPicker = () => fileInputRef.current?.click();

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void handleFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFiles]);

  const folderSupport = directoryPickerSupport();

  const openFolder = useCallback(async () => {
    try {
      const result = await pickImageFolder();
      if (result.cancelled) return;
      await handleFiles(result.files);
    } catch (error) {
      notify({ title: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  }, [handleFiles, notify]);

  const classMap = useMemo(
    () => new Map((project?.classes ?? []).map((cls) => [cls.id, cls])),
    [project],
  );

  const event = useStudio((state) => state.event);
  useEffect(() => {
    if (!event) return;
    const className = event.classId ? classMap.get(event.classId)?.name ?? '' : '';
    const kind = event.annotationKind ?? 'annotation';
    let text = '';
    switch (event.kind) {
      case 'added':
        text = t('studio.announce.added', { kind, name: className, count: event.count ?? 0 });
        break;
      case 'deleted':
        text = t('studio.announce.deleted');
        break;
      case 'selected':
        text = t('studio.announce.selected', { kind, name: className });
        break;
      case 'updated':
        text = t('studio.announce.updated');
        break;
      case 'undo':
        text = t('studio.announce.undo');
        break;
      case 'redo':
        text = t('studio.announce.redo');
        break;
      case 'image':
        text = t('studio.announce.image', {
          index: event.imageIndex ?? 0,
          total: event.imageTotal ?? 0,
          name: event.imageName ?? '',
        });
        break;
    }
    announce(text);
  }, [event, classMap, t, announce]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.closest('[role="dialog"]'))) {
        if (event.key !== 'Escape') return;
      }
      const store = useStudio.getState();
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) void store.redo();
        else void store.undo();
        return;
      }
      if (meta) return;
      const key = event.key;
      if (key === '?') {
        event.preventDefault();
        setShowShortcuts((current) => !current);
        return;
      }
      if (TOOL_KEYS[key]) {
        event.preventDefault();
        setMobilePanel(null);
        store.setTool(TOOL_KEYS[key]);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const cls = store.project?.classes[Number(key) - 1];
        if (cls) {
          event.preventDefault();
          store.setActiveClass(cls.id);
        }
        return;
      }
      if (key === '+' || key === '=') {
        event.preventDefault();
        store.setZoom(store.zoom * 1.25);
        return;
      }
      if (key === '-') {
        event.preventDefault();
        store.setZoom(store.zoom / 1.25);
        return;
      }
      if (key === '0') {
        event.preventDefault();
        store.requestFit();
        return;
      }
      const lower = key.toLowerCase();
      if (lower === 'a' || key === '[') {
        if (stepImage(-1)) event.preventDefault();
        return;
      }
      if (lower === 'd' || key === ']') {
        if (stepImage(1)) event.preventDefault();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onTransform = useCallback((nextZoom: number, nextPan: { x: number; y: number }) => {
    useStudio.getState().setZoom(nextZoom);
    useStudio.getState().setPan(nextPan);
  }, []);

  const onViewport = useCallback((width: number, height: number) => {
    useStudio.getState().setViewport(width, height);
  }, []);

  if (loading && !project) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-[var(--muted)]" />
      </div>
    );
  }

  if (!project) return <div className="p-6 text-sm">Project not found.</div>;

  const onUpdate = (id: string, geometry: Geometry, commit: boolean) => {
    updateAnnotation(id, geometry, { commit });
  };

  const canvas = image ? (
    bitmap ? (
      <CanvasStage
        image={image}
        bitmap={bitmap}
        annotations={currentAnnotations}
        classes={project.classes}
        selectedId={selectedAnnotationId}
        tool={tool}
        activeClassId={activeClassId}
        zoom={zoom}
        pan={pan}
        showAnnotations={showAnnotations}
        showConfidence={showConfidence}
        predictions={currentPredictions}
        fitNonce={fitNonce}
        onSelect={selectAnnotation}
        onCreate={(geometry) => {
          addAnnotation(geometry);
        }}
        onUpdate={onUpdate}
        onBeginEdit={() => beginEdit(image.id)}
        onDeleteSelected={() => {
          if (selectedAnnotationId) void deleteAnnotation(selectedAnnotationId);
        }}
        onTransform={onTransform}
        onViewport={onViewport}
      />
    ) : (
      <div className="grid h-full place-items-center">
        {bitmapError ? (
          <p role="alert" className="text-sm text-[var(--error)]">
            {bitmapError}
          </p>
        ) : (
          <Spinner className={bitmapLoading ? 'size-6 text-[var(--muted)]' : 'hidden'} />
        )}
      </div>
    )
  ) : (
    <div className="grid h-full place-items-center p-6">
      <EmptyState
        title={t('studio.noImages')}
        description={t('studio.noImagesDescription')}
        icon={<ImagePlus className="size-5" aria-hidden />}
        action={
          <div className="flex gap-2">
            <Button variant="primary" icon={<Upload className="size-4" aria-hidden />} onClick={openPicker}>
              {t('studio.addImages')}
            </Button>
          </div>
        }
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {region}
      <div className="flex min-h-0 flex-1">
        {railOpen ? (
          <div className="hidden w-64 shrink-0 lg:block">
            <ImageRail onUpload={openPicker} uploading={uploading} onOpenFolder={folderSupport.supported ? () => void openFolder() : undefined} />
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <Toolbar
            classes={project.classes}
            onAddClass={() => setShowClassDialog(true)}
            onShowShortcuts={() => setShowShortcuts(true)}
          />
          <div className="flex items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1 lg:hidden">
            <IconButton label={t('studio.images')} size="sm" onClick={() => setMobilePanel('images')}>
              <Images className="size-4" aria-hidden />
            </IconButton>
            <IconButton label={t('studio.prevImage')} size="sm" onClick={() => stepImage(-1)} disabled={!canPrev}>
              <ChevronLeft className="size-4" aria-hidden />
            </IconButton>
            <span className="truncate text-xs text-[var(--muted)]">{image?.name ?? t('studio.noImages')}</span>
            <IconButton label={t('studio.nextImage')} size="sm" onClick={() => stepImage(1)} disabled={!canNext}>
              <ChevronRight className="size-4" aria-hidden />
            </IconButton>
            <IconButton label="Inspector" size="sm" className="ml-auto" onClick={() => setMobilePanel('inspector')}>
              <PanelRight className="size-4" aria-hidden />
            </IconButton>
          </div>
          <div className="hidden items-center gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1 lg:flex">
            <IconButton
              label={railOpen ? t('studio.hideRail') : t('studio.showRail')}
              size="sm"
              active={railOpen}
              onClick={toggleRail}
            >
              <PanelLeft className="size-4" aria-hidden />
            </IconButton>
            <IconButton label={t('studio.prevImage')} size="sm" onClick={() => stepImage(-1)} disabled={!canPrev}>
              <ChevronLeft className="size-4" aria-hidden />
            </IconButton>
            <span className="truncate text-xs text-[var(--muted)]">{image?.name ?? t('studio.noImages')}</span>
            <IconButton label={t('studio.nextImage')} size="sm" onClick={() => stepImage(1)} disabled={!canNext}>
              <ChevronRight className="size-4" aria-hidden />
            </IconButton>
            <span className="ml-auto hidden min-[1280px]:inline-flex">
              <IconButton
                label={inspectorOpen ? t('studio.hideInspector') : t('studio.showInspector')}
                size="sm"
                active={inspectorOpen}
                onClick={toggleInspector}
              >
                <PanelRight className="size-4" aria-hidden />
              </IconButton>
            </span>
          </div>
          <div className="relative min-h-0 flex-1">{canvas}</div>
          <StatusBar
            name={image?.name}
            count={currentAnnotations.length}
            suggestions={currentPredictions.length}
            tool={tool}
            hasImage={Boolean(image)}
          />
        </div>

        {inspectorOpen ? (
          <div className="hidden w-80 shrink-0 xl:block">
            <InspectorPanel image={image} />
          </div>
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.zip"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          void handleFiles(files);
        }}
      />

      <div
        className={`absolute inset-0 z-30 ${dragging ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'} transition-opacity`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void filesFromDataTransfer(event.dataTransfer).then((files) => handleFiles(files));
        }}
        aria-hidden={!dragging}
      >
        <div className="grid size-full place-items-center bg-[var(--scrim)] p-6">
          <div className="rounded-2xl border-2 border-dashed border-[var(--accent)] bg-[var(--surface)] px-10 py-8 text-center">
            <ImagePlus className="mx-auto mb-2 size-8 text-[var(--accent)]" aria-hidden />
            <p className="text-sm font-semibold">{t('studio.dropImages')}</p>
            <p className="mt-1 text-xs text-[var(--muted)]">{t('studio.dropHint')}</p>
          </div>
        </div>
      </div>

      <ClassDialog
        open={showClassDialog}
        onOpenChange={setShowClassDialog}
        projectType={project.type}
        onCreate={(name, keypoints) => addClass(name, keypoints)}
      />
      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />

      <Dialog
        open={mobilePanel !== null}
        onOpenChange={(open) => !open && setMobilePanel(null)}
        title={mobilePanel === 'images' ? t('studio.images') : 'Inspector'}
        wide
      >
        <div className="h-[70vh] min-h-0">
          {mobilePanel === 'images' ? (
            <ImageRail
              onUpload={() => {
                setMobilePanel(null);
                openPicker();
              }}
              uploading={uploading}
              onOpenFolder={folderSupport.supported ? () => {
                setMobilePanel(null);
                void openFolder();
              } : undefined}
            />
          ) : (
            <InspectorPanel image={image} />
          )}
        </div>
      </Dialog>

    </div>
  );
}

function StatusBar({
  name,
  count,
  suggestions,
  tool,
  hasImage,
}: {
  name?: string;
  count: number;
  suggestions: number;
  tool: string;
  hasImage: boolean;
}) {
  const { t } = useT();
  const toolLabelKey = `studio.tool.${tool}` as MessageKey;
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-t border-[var(--border)] bg-[var(--surface)] px-3 text-[11px] text-[var(--muted)]">
      <span className="truncate">{hasImage ? name : t('studio.noImages')}</span>
      <span aria-hidden>·</span>
      <span>
        {count} {t(count === 1 ? 'common.annotation.one' : 'common.annotation.other')}
      </span>
      {suggestions > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span className="text-[var(--accent)]">{suggestions} auto</span>
        </>
      ) : null}
      <span className="ml-auto hidden sm:inline">{t(toolLabelKey)}</span>
      <span className="hidden md:inline">? {t('common.help')}</span>
    </div>
  );
}