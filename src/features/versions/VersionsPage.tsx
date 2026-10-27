import { useEffect, useMemo, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { Archive, Download, Plus, Trash2 } from 'lucide-react';
import type {
  Annotation,
  AugmentationConfig,
  DatasetVersion,
  ImageMeta,
  PreprocessConfig,
  Project,
  SplitName,
} from '@/core/types';
import { DEFAULT_AUGMENT, DEFAULT_PREPROCESS } from '@/core/types';
import {
  assignSplit,
  createVersion,
  deleteVersion,
  getImageBlob,
  listAnnotations,
  listImages,
  listVersions,
  saveProject,
  saveVersion,
} from '@/core/repo';
import { buildExport, zipExport, type ExportFormat } from '@/core/exporters';
import { directoryPickerSupport, saveFilesToFolder } from '@/core/fs-access';
import { useT, useToast } from '@/ui/i18n';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Textarea } from '@/ui/primitives';
import { Dialog, Select, Slider, Switch } from '@/ui/heavy';
import { Page } from '@/features/shell/AppShell';
import { downloadBlob, formatDate, formatPercent, safeFilename } from '@/lib/utils';

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'yolo', label: 'YOLO (Ultralytics / YOLOv8)' },
  { value: 'yolo-seg', label: 'YOLO segmentation' },
  { value: 'coco', label: 'COCO JSON' },
  { value: 'voc', label: 'Pascal VOC XML' },
  { value: 'csv', label: 'CSV' },
  { value: 'openlabel', label: 'OpenLabel JSON' },
];

export function VersionsPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const { t } = useT();
  const { notify } = useToast();
  const { projectId = '' } = useParams();
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState<DatasetVersion | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [nextImages, nextAnnotations, nextVersions] = await Promise.all([
      listImages(projectId),
      listAnnotations(projectId),
      listVersions(projectId),
    ]);
    setImages(nextImages);
    setAnnotations(nextAnnotations);
    setVersions(nextVersions);
  };

  useEffect(() => {
    void refresh();
  }, [projectId]);

  const unannotated = useMemo(() => images.filter((image) => image.annotationCount === 0).length, [images]);

  return (
    <Page>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('versions.title')}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('versions.subtitle')}</p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
          {t('versions.create')}
        </Button>
      </header>

      <Card className="mb-4 flex flex-wrap items-center gap-4 text-xs text-[var(--muted)]">
        <span>
          {images.length} {t('common.images')}
        </span>
        <span>
          {annotations.length} {t('common.annotations')}
        </span>
        <span>{unannotated} unannotated</span>
        <span className="ml-auto">
          {t('versions.split')}: {project.split.train} / {project.split.valid} / {project.split.test}
        </span>
      </Card>

      {versions.length === 0 ? (
        <EmptyState
          title={t('versions.empty')}
          description={t('versions.emptyDescription')}
          icon={<Archive className="size-5" aria-hidden />}
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('versions.create')}
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {versions.map((version) => (
            <li key={version.id}>
              <Card className="flex h-full flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold">
                      v{version.number} · {version.name}
                    </h2>
                    <p className="mt-0.5 text-[11px] text-[var(--muted)]">{formatDate(version.createdAt)}</p>
                  </div>
                  <Badge tone="success">{version.imageCount} images</Badge>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-md bg-[var(--surface-2)] p-1.5">
                    <dt className="text-[10px] text-[var(--muted)]">train</dt>
                    <dd className="font-mono">{version.splitCounts.train}</dd>
                  </div>
                  <div className="rounded-md bg-[var(--surface-2)] p-1.5">
                    <dt className="text-[10px] text-[var(--muted)]">valid</dt>
                    <dd className="font-mono">{version.splitCounts.valid}</dd>
                  </div>
                  <div className="rounded-md bg-[var(--surface-2)] p-1.5">
                    <dt className="text-[10px] text-[var(--muted)]">test</dt>
                    <dd className="font-mono">{version.splitCounts.test}</dd>
                  </div>
                </dl>
                <ul className="flex flex-wrap gap-1">
                  {project.classes.map((cls) => (
                    <li
                      key={cls.id}
                      className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px]"
                    >
                      <span className="size-2 rounded-full" style={{ backgroundColor: cls.color }} aria-hidden />
                      {cls.name}
                      <span className="font-mono text-[var(--muted)]">{version.classCounts[cls.id] ?? 0}</span>
                    </li>
                  ))}
                </ul>
                {version.notes ? <p className="text-xs text-[var(--muted)]">{version.notes}</p> : null}
                <div className="mt-auto flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" icon={<Download className="size-4" aria-hidden />} onClick={() => setExporting(version)}>
                    {t('versions.export')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 className="size-4" aria-hidden />}
                    onClick={() => {
                      if (!window.confirm(`${t('common.delete')} v${version.number}?`)) return;
                      void deleteVersion(version.id).then(refresh);
                    }}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <CreateVersionDialog
        open={creating}
        onOpenChange={setCreating}
        project={project}
        images={images}
        annotations={annotations}
        nextNumber={(versions[0]?.number ?? 0) + 1}
        onCreated={async (version) => {
          await saveVersion(version);
          await refresh();
          setCreating(false);
          setExporting(version);
        }}
        busy={busy}
        setBusy={setBusy}
      />

      <ExportDialog
        version={exporting}
        project={project}
        images={images}
        annotations={annotations}
        onOpenChange={(open) => !open && setExporting(null)}
        onExported={(filename) => notify({ title: t('versions.export'), description: filename, tone: 'success' })}
      />
    </Page>
  );
}

function CreateVersionDialog({
  open,
  onOpenChange,
  project,
  images,
  annotations,
  nextNumber,
  onCreated,
  busy,
  setBusy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  images: ImageMeta[];
  annotations: Annotation[];
  nextNumber: number;
  onCreated: (version: DatasetVersion) => Promise<void>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(`v${nextNumber}`);
  const [notes, setNotes] = useState('');
  const [split, setSplit] = useState(project.split);
  const [preprocess, setPreprocess] = useState<PreprocessConfig>(DEFAULT_PREPROCESS);
  const [augment, setAugment] = useState<AugmentationConfig>(DEFAULT_AUGMENT);

  useEffect(() => {
    if (open) {
      setName(`v${nextNumber}`);
      setNotes('');
      setSplit(project.split);
    }
  }, [open, nextNumber, project.split]);

  const total = split.train + split.valid + split.test;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('versions.create')}
      description={t('versions.emptyDescription')}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={total !== 100 || images.length === 0}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  await saveProject({ ...project, split });
                  const version = createVersion({
                    project: { ...project, split },
                    images,
                    annotations,
                    name: name.trim() || `v${nextNumber}`,
                    number: nextNumber,
                    preprocess,
                    augment,
                    notes,
                  });
                  await onCreated(version);
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('versions.name')} htmlFor="version-name">
            <Input id="version-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <div className="space-y-1.5">
            <span className="text-[13px] font-medium">{t('versions.split')}</span>
            <div className="grid grid-cols-3 gap-1.5">
              {(['train', 'valid', 'test'] as SplitName[]).map((key) => (
                <label key={key} className="block">
                  <span className="mb-0.5 block text-[11px] text-[var(--muted)]">{key}</span>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={split[key]}
                    aria-label={`${key} split percent`}
                    onChange={(event) => setSplit({ ...split, [key]: Number(event.target.value) })}
                    className="h-8 text-xs"
                  />
                </label>
              ))}
            </div>
            {total !== 100 ? (
              <p role="alert" className="text-[11px] text-[var(--error)]">
                Splits must add up to 100 ({total}).
              </p>
            ) : null}
          </div>
        </div>

        <Field label={t('versions.notes')} htmlFor="version-notes">
          <Textarea id="version-notes" value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-16" />
        </Field>

        <section className="rounded-lg border border-[var(--border)] p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            {t('versions.preprocess')}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('versions.resizeMode')} htmlFor="resize-mode">
              <Select<PreprocessConfig['resizeMode']>
                label={t('versions.resizeMode')}
                value={preprocess.resizeMode}
                onChange={(value) => setPreprocess({ ...preprocess, resizeMode: value })}
                options={[
                  { value: 'none', label: t('versions.resize.none') },
                  { value: 'stretch', label: t('versions.resize.stretch') },
                  { value: 'fit', label: t('versions.resize.fit') },
                ]}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('versions.width')} htmlFor="resize-width">
                <Input
                  id="resize-width"
                  type="number"
                  value={preprocess.width}
                  onChange={(event) => setPreprocess({ ...preprocess, width: Number(event.target.value) })}
                  className="h-8"
                />
              </Field>
              <Field label={t('versions.height')} htmlFor="resize-height">
                <Input
                  id="resize-height"
                  type="number"
                  value={preprocess.height}
                  onChange={(event) => setPreprocess({ ...preprocess, height: Number(event.target.value) })}
                  className="h-8"
                />
              </Field>
            </div>
          </div>
          <div className="mt-3">
            <Switch
              checked={preprocess.grayscale}
              onChange={(value) => setPreprocess({ ...preprocess, grayscale: value })}
              label={t('versions.grayscale')}
            />
          </div>
        </section>

        <section className="rounded-lg border border-[var(--border)] p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            {t('versions.augmentation')}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Checkbox
                checked={augment.flipHorizontal}
                onChange={(value) => setAugment({ ...augment, flipHorizontal: value })}
                label={t('versions.flipHorizontal')}
              />
              <Checkbox
                checked={augment.flipVertical}
                onChange={(value) => setAugment({ ...augment, flipVertical: value })}
                label={t('versions.flipVertical')}
              />
              <Checkbox
                checked={augment.rotate90}
                onChange={(value) => setAugment({ ...augment, rotate90: value })}
                label={t('versions.rotate90')}
              />
            </div>
            <div className="space-y-1">
              <div className="grid grid-cols-2 gap-2">
                <Slider
                  label={t('versions.copies')}
                  value={augment.copies}
                  min={0}
                  max={8}
                  step={1}
                  onChange={(value) => setAugment({ ...augment, copies: value })}
                  format={(value) => String(value)}
                />
                <Slider
                  label={t('versions.noise')}
                  value={augment.noise}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(value) => setAugment({ ...augment, noise: value })}
                  format={(value) => formatPercent(value, 0)}
                />
              </div>
              <Slider
                label={t('versions.brightness')}
                value={augment.brightness}
                min={-0.6}
                max={0.6}
                step={0.05}
                onChange={(value) => setAugment({ ...augment, brightness: value })}
                format={(value) => value.toFixed(2)}
              />
              <Slider
                label={t('versions.contrast')}
                value={augment.contrast}
                min={-0.6}
                max={0.6}
                step={0.05}
                onChange={(value) => setAugment({ ...augment, contrast: value })}
                format={(value) => value.toFixed(2)}
              />
              <Slider
                label={t('versions.saturation')}
                value={augment.saturation}
                min={-1}
                max={1}
                step={0.05}
                onChange={(value) => setAugment({ ...augment, saturation: value })}
                format={(value) => value.toFixed(2)}
              />
              <Slider
                label={t('versions.blur')}
                value={augment.blur}
                min={0}
                max={8}
                step={0.5}
                onChange={(value) => setAugment({ ...augment, blur: value })}
                format={(value) => value.toFixed(1)}
              />
            </div>
          </div>
        </section>
      </div>
    </Dialog>
  );
}

function ExportDialog({
  version,
  project,
  images,
  annotations,
  onOpenChange,
  onExported,
}: {
  version: DatasetVersion | null;
  project: Project;
  images: ImageMeta[];
  annotations: Annotation[];
  onOpenChange: (open: boolean) => void;
  onExported: (filename: string) => void;
}) {
  const { t } = useT();
  const { notify } = useToast();
  const [format, setFormat] = useState<ExportFormat>('yolo');
  const [includeImages, setIncludeImages] = useState(true);
  const [busy, setBusy] = useState(false);
  const folderSupport = directoryPickerSupport();

  const prepare = async () => {
    if (!version) return null;
    const allowed = new Set(version.imageIds);
    const versionImages = images.filter((image) => allowed.has(image.id));
    const versionAnnotations = annotations.filter((annotation) => allowed.has(annotation.imageId));
    const indexOf = new Map(versionImages.map((image, index) => [image.id, index]));
    const result = await buildExport(
      {
        project,
        images: versionImages,
        annotations: versionAnnotations,
        splitOf: (image) => image.split ?? assignSplit(indexOf.get(image.id) ?? 0, version.split),
        preprocess: version.preprocess,
        augment: version.augment,
        includeImages,
        loadBlob: (imageId) => getImageBlob(imageId),
      },
      format,
    );
    return {
      files: result.files,
      warnings: result.warnings,
      filename: `${safeFilename(project.name)}_v${version.number}_${format}.zip`,
    };
  };

  const reportWarnings = (warnings: string[]) => {
    if (warnings.length > 0) {
      notify({ title: 'Export warnings', description: warnings.slice(0, 2).join(' · '), tone: 'info' });
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const prepared = await prepare();
      if (!prepared) return;
      const zip = await zipExport(prepared.files);
      downloadBlob(zip, prepared.filename);
      reportWarnings(prepared.warnings);
      onExported(prepared.filename);
      onOpenChange(false);
    } catch (error) {
      notify({ title: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveToFolder = async () => {
    setBusy(true);
    try {
      const prepared = await prepare();
      if (!prepared) return;
      const result = await saveFilesToFolder(prepared.files);
      if (!result.cancelled) {
        notify({ title: t('versions.saved', { count: result.saved }), description: prepared.filename, tone: 'success' });
        reportWarnings(prepared.warnings);
        onOpenChange(false);
      }
    } catch (error) {
      notify({ title: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={version !== null}
      onOpenChange={onOpenChange}
      title={`${t('versions.exportTitle')}${version ? ` · v${version.number}` : ''}`}
      description={version ? `${version.imageCount} images · ${version.annotationCount} annotations` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {folderSupport.supported ? (
            <Button variant="secondary" onClick={() => void saveToFolder()} disabled={busy} title={t('versions.folderHint')}>
              {t('versions.saveToFolder')}
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => void run()} loading={busy}>
            {busy ? t('versions.downloading') : t('common.download')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('versions.format')} htmlFor="export-format">
          <Select<ExportFormat>
            label={t('versions.format')}
            value={format}
            onChange={setFormat}
            options={FORMATS}
          />
        </Field>
        <Checkbox
          checked={includeImages}
          onChange={setIncludeImages}
          label={t('versions.includeImages')}
          description={version?.augment.copies ? `+${version.augment.copies} augmented variants per image` : undefined}
        />
      </div>
    </Dialog>
  );
}