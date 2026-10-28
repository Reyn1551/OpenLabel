import { useEffect, useMemo, useState } from 'react';
import { Tags, Trash2, Type } from 'lucide-react';
import type { Annotation, ImageMeta, SplitName } from '@/core/types';
import { useStudio } from '@/core/store';
import { useT } from '@/ui/i18n';
import { useToast } from '@/ui/i18n';
import {
  Badge,
  Button,
  IconButton,
  Input,
  Textarea,
} from '@/ui/primitives';
import { Select, Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/heavy';
import { geometryLabel } from '@/core/geometry';
import { formatDate } from '@/lib/utils';
import { AutoLabelPanel } from './AutoLabelPanel';
import { deleteImages } from '@/core/repo';
import { findSimilarImages } from '@/core/health';
import { useThumb } from './useThumb';

export function InspectorPanel({ image }: { image: ImageMeta | null }) {
  const { t } = useT();
  const { notify } = useToast();
  const project = useStudio((state) => state.project);
  const annotations = useStudio((state) => state.annotations);
  const selectedImageId = useStudio((state) => state.selectedImageId);
  const selectedAnnotationId = useStudio((state) => state.selectedAnnotationId);
  const selectAnnotation = useStudio((state) => state.selectAnnotation);
  const deleteAnnotation = useStudio((state) => state.deleteAnnotation);
  const duplicateAnnotation = useStudio((state) => state.duplicateAnnotation);
  const addClass = useStudio((state) => state.addClass);
  const updateClass = useStudio((state) => state.updateClass);
  const deleteClass = useStudio((state) => state.deleteClass);
  const setSplit = useStudio((state) => state.setSplit);
  const setTags = useStudio((state) => state.setTags);
  const setNote = useStudio((state) => state.setNote);
  const refreshImages = useStudio((state) => state.refreshImages);
  const images = useStudio((state) => state.images);
  const selectImage = useStudio((state) => state.selectImage);
  const updateAnnotation = useStudio((state) => state.updateAnnotation);
  const beginEdit = useStudio((state) => state.beginEdit);

  const [newClass, setNewClass] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [note, setNoteLocal] = useState(image?.note ?? '');
  const [tab, setTab] = useState('annotations');

  useEffect(() => {
    setNoteLocal(image?.note ?? '');
    setTagDraft('');
  }, [image?.id, image?.note]);

  const list = useMemo(
    () => (selectedImageId ? annotations[selectedImageId] ?? [] : []),
    [annotations, selectedImageId],
  );
  const classes = project?.classes ?? [];
  const classMap = useMemo(() => new Map(classes.map((cls) => [cls.id, cls])), [classes]);
  const selectedBbox = useMemo(() => {
    const found = list.find((annotation) => annotation.id === selectedAnnotationId);
    return found && found.geometry.kind === 'bbox' ? { id: found.id, geometry: found.geometry } : null;
  }, [list, selectedAnnotationId]);

  return (
    <aside
      aria-label="Inspector"
      className="flex h-full min-h-0 flex-col border-l border-[var(--border)] bg-[var(--surface)]"
    >
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[var(--border)] p-2">
          <TabsList label="Inspector sections">
            <TabsTrigger value="annotations">{t('common.annotations')}</TabsTrigger>
            <TabsTrigger value="autolabel">{t('autolabel.title')}</TabsTrigger>
            <TabsTrigger value="image">{t('studio.images')}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="annotations" className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">{t('studio.annotationList')}</h2>
            <Badge>{list.length}</Badge>
          </div>
          {selectedBbox ? (
            <BoxGeometryEditor
              key={selectedBbox.id}
              geometry={selectedBbox.geometry}
              onCommit={(next) => {
                if (selectedImageId) beginEdit(selectedImageId);
                updateAnnotation(selectedBbox.id, next, { commit: true });
              }}
            />
          ) : null}
          {list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border)] p-4 text-xs text-[var(--muted)]">
              {t('studio.noAnnotations')}
            </p>
          ) : (
            <ul className="space-y-1" aria-label={t('studio.annotationList')}>
              {list.map((annotation) => (
                <AnnotationRow
                  key={annotation.id}
                  annotation={annotation}
                  className={classMap.get(annotation.classId)?.name ?? ''}
                  color={classMap.get(annotation.classId)?.color ?? '#94a3b8'}
                  selected={annotation.id === selectedAnnotationId}
                  onSelect={() => selectAnnotation(annotation.id)}
                  onDelete={() => void deleteAnnotation(annotation.id)}
                  onDuplicate={() => duplicateAnnotation(annotation.id)}
                />
              ))}
            </ul>
          )}

          <section aria-label={t('studio.activeClass')} className="mt-5 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              {t('common.classes')} ({classes.length})
            </h3>
            <ul className="space-y-1">
              {classes.map((cls) => (
                <li key={cls.id} className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1">
                  <input
                    type="color"
                    value={cls.color}
                    aria-label={`${cls.name} color`}
                    onChange={(event) => void updateClass(cls.id, { color: event.target.value })}
                    className="size-5 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0"
                  />
                  <input
                    value={cls.name}
                    aria-label={`${cls.name} name`}
                    onChange={(event) => void updateClass(cls.id, { name: event.target.value })}
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                  />
                  <span className="font-mono text-[10px] text-[var(--muted)]">
                    {list.filter((a) => a.classId === cls.id).length}
                  </span>
                  <IconButton
                    label={`${t('common.delete')} ${cls.name}`}
                    size="sm"
                    onClick={() => {
                      if (window.confirm(t('studio.deleteClassConfirm'))) void deleteClass(cls.id);
                    }}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newClass.trim()) return;
                void addClass(newClass).then(() => setNewClass(''));
              }}
            >
              <Input
                value={newClass}
                onChange={(event) => setNewClass(event.target.value)}
                placeholder={t('studio.className')}
                aria-label={t('studio.className')}
                className="h-8 text-xs"
              />
              <Button type="submit" size="sm" variant="secondary" icon={<Type className="size-3.5" aria-hidden />}>
                {t('common.create')}
              </Button>
            </form>
          </section>
        </TabsContent>

        <TabsContent value="autolabel" className="min-h-0 flex-1 overflow-y-auto p-3">
          <AutoLabelPanel />
        </TabsContent>

        <TabsContent value="image" className="min-h-0 flex-1 overflow-y-auto p-3">
          {image ? (
            <div className="space-y-4">
              <header className="space-y-1">
                <h2 className="truncate text-sm font-semibold" title={image.name}>
                  {image.name}
                </h2>
                <p className="font-mono text-[11px] text-[var(--muted)]">
                  {image.width}×{image.height} · {(image.bytes / 1024).toFixed(0)} KB
                </p>
                <p className="text-[11px] text-[var(--muted)]">{formatDate(image.createdAt)}</p>
              </header>

              <label className="block space-y-1">
                <span className="text-[13px] font-medium">{t('studio.split')}</span>
                <Select<'auto' | SplitName>
                  label={t('studio.split')}
                  value={image.split ?? 'auto'}
                  onChange={(value) => void setSplit(image.id, value === 'auto' ? null : value)}
                  options={[
                    { value: 'auto', label: t('studio.split.auto') },
                    { value: 'train', label: t('studio.split.train') },
                    { value: 'valid', label: t('studio.split.valid') },
                    { value: 'test', label: t('studio.split.test') },
                  ]}
                />
              </label>

              <div className="space-y-1.5">
                <span className="text-[13px] font-medium">{t('studio.tags')}</span>
                <div className="flex flex-wrap gap-1">
                  {image.tags.map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px]">
                      <Tags className="size-3" aria-hidden />
                      {tag}
                      <button
                        type="button"
                        aria-label={`Remove tag ${tag}`}
                        onClick={() => void setTags(image.id, image.tags.filter((item) => item !== tag))}
                        className="text-[var(--muted)]"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <Input
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    const value = tagDraft.trim();
                    if (!value) return;
                    void setTags(image.id, Array.from(new Set([...image.tags, value])));
                    setTagDraft('');
                  }}
                  placeholder={t('studio.tagsPlaceholder')}
                  aria-label={t('studio.tags')}
                  className="h-8 text-xs"
                />
              </div>

              <label className="block space-y-1">
                <span className="text-[13px] font-medium">{t('studio.note')}</span>
                <Textarea
                  value={note}
                  onChange={(event) => setNoteLocal(event.target.value)}
                  onBlur={() => {
                    if (note !== image.note) void setNote(image.id, note);
                  }}
                  placeholder={t('studio.notePlaceholder')}
                  className="min-h-24 text-xs"
                />
              </label>

              <section aria-label={t('studio.similar')} className="space-y-1.5">
                <h3 className="text-[13px] font-medium">{t('studio.similar')}</h3>
                <p className="text-[11px] text-[var(--muted)]">{t('studio.similarHint')}</p>
                <SimilarImages
                  imageId={image.id}
                  images={images}
                  onSelect={(id) => selectImage(id)}
                />
              </section>

              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 className="size-4" aria-hidden />}
                onClick={() => {
                  if (!window.confirm(`${t('common.delete')} ${image.name}?`)) return;
                  void deleteImages(image.projectId, [image.id]).then(async () => {
                    await refreshImages();
                    notify({ title: `${image.name} ${t('common.delete').toLowerCase()}`, tone: 'info' });
                  });
                }}
              >
                {t('common.delete')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-[var(--muted)]">No image selected.</p>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}


/**
 * Numeric box editor.
 *
 * Dragging a handle is imprecise on a small screen, so the selected box also
 * exposes its four numbers. Edits apply on Enter or blur, which keeps undo
 * history at one entry per deliberate change instead of one per keystroke.
 */
function BoxGeometryEditor({
  geometry,
  onCommit,
}: {
  geometry: { x: number; y: number; width: number; height: number };
  onCommit: (next: { kind: 'bbox'; x: number; y: number; width: number; height: number }) => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState(() => ({
    x: Math.round(geometry.x),
    y: Math.round(geometry.y),
    width: Math.round(geometry.width),
    height: Math.round(geometry.height),
  }));

  useEffect(() => {
    setDraft({
      x: Math.round(geometry.x),
      y: Math.round(geometry.y),
      width: Math.round(geometry.width),
      height: Math.round(geometry.height),
    });
  }, [geometry.x, geometry.y, geometry.width, geometry.height]);

  const commit = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    const width = Math.max(2, Math.round(next.width));
    const height = Math.max(2, Math.round(next.height));
    const x = Math.round(next.x);
    const y = Math.round(next.y);
    setDraft({ x, y, width, height });
    if (
      x === Math.round(geometry.x) &&
      y === Math.round(geometry.y) &&
      width === Math.round(geometry.width) &&
      height === Math.round(geometry.height)
    ) {
      return;
    }
    onCommit({ kind: 'bbox', x, y, width, height });
  };

  const field = (
    key: keyof typeof draft,
    label: string,
    min?: number,
  ) => (
    <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
      <span className="w-3 shrink-0">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        value={draft[key]}
        onChange={(event) => setDraft((prev) => ({ ...prev, [key]: Number(event.target.value) }))}
        onBlur={() => commit({})}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit({});
            event.currentTarget.blur();
          }
        }}
        className="h-7 w-full px-1.5 text-xs tabular-nums"
      />
    </label>
  );

  return (
    <section aria-label={t('studio.boxGeometry')} className="mb-3 space-y-1.5 rounded-lg border border-[var(--border)] p-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
        {t('studio.boxGeometry')}
      </h3>
      <div className="grid grid-cols-2 gap-1.5">
        {field('x', 'X')}
        {field('y', 'Y')}
        {field('width', 'W', 2)}
        {field('height', 'H', 2)}
      </div>
    </section>
  );
}

function AnnotationRow({
  annotation,
  className,
  color,
  selected,
  onSelect,
  onDelete,
  onDuplicate,
}: {
  annotation: Annotation;
  className: string;
  color: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useT();
  return (
    <li
      className={`group flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${
        selected ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]' : 'border-[var(--border)]'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={geometryLabel(annotation.geometry)}
      >
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{className || 'Unknown'}</span>
          <span className="block truncate text-[10px] text-[var(--muted)]">
            {annotation.geometry.kind}
            {annotation.confidence !== undefined ? ` · ${Math.round(annotation.confidence * 100)}%` : ''}
            {annotation.source === 'auto' ? ' · auto' : ''}
          </span>
        </span>
      </button>
      <IconButton label={`${t('studio.duplicate')} ${className}`} size="sm" onClick={onDuplicate} className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <span aria-hidden className="text-xs">⧉</span>
      </IconButton>
      <IconButton
        label={`${t('common.delete')} ${className}`}
        size="sm"
        onClick={onDelete}
        className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" aria-hidden />
      </IconButton>
    </li>
  );
}
function SimilarImages({
  imageId,
  images,
  onSelect,
}: {
  imageId: string;
  images: ImageMeta[];
  onSelect: (id: string) => void;
}) {
  const { t } = useT();
  const similar = findSimilarImages(images, imageId, 4);
  if (similar.length === 0) {
    return <p className="text-[11px] text-[var(--muted)]">{t('studio.similarNone')}</p>;
  }
  return (
    <ul className="grid grid-cols-4 gap-1.5">
      {similar.map((item) => (
        <li key={item.imageId}>
          <SimilarThumb imageId={item.imageId} score={item.score} onSelect={() => onSelect(item.imageId)} />
        </li>
      ))}
    </ul>
  );
}

function SimilarThumb({ imageId, score, onSelect }: { imageId: string; score: number; onSelect: () => void }) {
  const url = useThumb(imageId);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group relative block aspect-square w-full overflow-hidden rounded border border-[var(--border)] bg-[var(--surface-2)]"
      title={`Similarity ${(score * 100).toFixed(0)}%`}
    >
      {url ? <img src={url} alt="" className="size-full object-cover" loading="lazy" /> : null}
      <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[10px] text-white">
        {(score * 100).toFixed(0)}%
      </span>
    </button>
  );
}
