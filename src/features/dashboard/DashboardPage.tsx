import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Boxes,
  Check,
  Database,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Project, ProjectType } from '@/core/types';
import {
  createProject,
  deleteProject,
  projectSummaries,
  putAnnotations,
  storageEstimate,
  uid,
  now,
  type ProjectSummary,
} from '@/core/repo';
import { importFiles } from '@/core/import';
import { generateSampleScenes, SAMPLE_CLASSES } from '@/core/samples';
import { useT, useToast } from '@/ui/i18n';
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, Spinner } from '@/ui/primitives';
import { LazyDialog, LazyMenu } from '@/ui/lazy';
import { Page } from '@/features/shell/AppShell';
import { cn, dataUrlToBlob, formatBytes, formatDate } from '@/lib/utils';

const PROJECT_TYPES: ProjectType[] = [
  'object-detection',
  'instance-segmentation',
  'keypoint',
  'classification',
];

export function DashboardPage() {
  const { t } = useT();
  const { notify } = useToast();
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);

  const refresh = async () => {
    setSummaries(await projectSummaries());
    setStorage(await storageEstimate());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const loadDemo = async () => {
    setLoadingDemo(true);
    try {
      const project = await createProject({
        name: 'Demo: industrial parts',
        type: 'object-detection',
        classes: [...SAMPLE_CLASSES],
        description: 'Synthetic parts generated in the browser. Annotate more, then train Auto Label.',
      });
      const scenes = await generateSampleScenes(16);
      const files: File[] = [];
      for (const scene of scenes) {
        const blob = dataUrlToBlob(scene.pngDataUrl);
        files.push(new File([blob], scene.name, { type: 'image/png' }));
      }
      const result = await importFiles(project.id, files);
      const byName = new Map(scenes.map((scene) => [scene.name, scene]));
      const classByName = new Map(project.classes.map((cls) => [cls.name, cls.id]));
      const annotations = [];
      // Only the first seven images start annotated, so the auto-label loop is visible.
      for (const meta of result.added.slice(0, 7)) {
        const scene = byName.get(meta.name);
        if (!scene) continue;
        for (const label of scene.labels) {
          const classId = classByName.get(label.className);
          if (!classId) continue;
          annotations.push({
            id: uid('ann'),
            projectId: project.id,
            imageId: meta.id,
            classId,
            geometry: { kind: 'bbox' as const, ...label.box },
            attributes: {},
            source: 'human' as const,
            createdAt: now(),
            updatedAt: now(),
          });
        }
      }
      await putAnnotations(annotations);
      await refresh();
      notify({ title: 'Demo dataset ready', description: `${result.added.length} images, ${annotations.length} annotations`, tone: 'success' });
      navigate(`/projects/${project.id}/annotate`);
    } catch (error) {
      notify({ title: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setLoadingDemo(false);
    }
  };

  return (
    <Page>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">{t('dashboard.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon={loadingDemo ? <Spinner className="size-4" /> : <Sparkles className="size-4" aria-hidden />}
            onClick={() => void loadDemo()}
            disabled={loadingDemo}
          >
            {t('dashboard.loadSample')}
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
            {t('dashboard.newProject')}
          </Button>
        </div>
      </header>

      {summaries === null ? (
        <div className="grid place-items-center py-20">
          <Spinner className="size-6 text-[var(--muted)]" />
        </div>
      ) : summaries.length === 0 ? (
        <EmptyState
          title={t('dashboard.emptyTitle')}
          description={t('dashboard.emptyDescription')}
          icon={<Boxes className="size-5" aria-hidden />}
          action={
            <div className="flex gap-2">
              <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
                {t('dashboard.newProject')}
              </Button>
              <Button variant="secondary" onClick={() => void loadDemo()} disabled={loadingDemo}>
                {t('dashboard.loadSample')}
              </Button>
            </div>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {summaries.map(({ project, imageCount, annotationCount, versionCount, modelCount }) => (
            <li key={project.id}>
              <ProjectCard
                project={project}
                imageCount={imageCount}
                annotationCount={annotationCount}
                versionCount={versionCount}
                modelCount={modelCount}
                onDelete={async () => {
                  if (!window.confirm(t('dashboard.deleteConfirm'))) return;
                  await deleteProject(project.id);
                  await refresh();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {storage ? (
        <Card className="mt-6 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
          <Database className="size-4" aria-hidden />
          <span className="font-medium text-[var(--fg)]">{t('dashboard.storage')}</span>
          <span>
            {t('dashboard.storageDetail', {
              used: formatBytes(storage.usage),
              quota: formatBytes(storage.quota),
            })}
          </span>
          <span className="ml-auto">{t('settings.offlineReady')}</span>
        </Card>
      ) : null}

      {creating ? (
        <NewProjectDialog open={creating} onOpenChange={setCreating} onCreated={(project) => navigate(`/projects/${project.id}/annotate`)} />
      ) : null}
    </Page>
  );
}

function ProjectCard({
  project,
  imageCount,
  annotationCount,
  versionCount,
  modelCount,
  onDelete,
}: {
  project: Project;
  imageCount: number;
  annotationCount: number;
  versionCount: number;
  modelCount: number;
  onDelete: () => Promise<void>;
}) {
  const { t } = useT();
  const minAnnotations = project.autoLabel?.minAnnotations ?? 10;
  const steps = [
    { label: t('dashboard.step.images'), done: imageCount > 0 },
    { label: t('dashboard.step.annotate'), done: annotationCount >= minAnnotations },
    { label: t('dashboard.step.train'), done: modelCount > 0 },
    { label: t('dashboard.step.freeze'), done: versionCount > 0 },
  ];
  const current = steps.findIndex((step) => !step.done);
  return (
    <div className="group relative flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--elev-1)] transition-shadow hover:shadow-[var(--elev-2)]">
      <div className="flex items-start justify-between gap-2">
        <Badge tone="accent">{t(`project.type.${project.type}` as const)}</Badge>
        <LazyMenu
          label={`Actions for ${project.name}`}
          trigger={
            <IconButton label={`Actions for ${project.name}`} size="sm">
              <MoreHorizontal className="size-4" aria-hidden />
            </IconButton>
          }
          items={[
            {
              label: t('common.delete'),
              destructive: true,
              icon: <Trash2 className="size-4" aria-hidden />,
              onSelect: () => void onDelete(),
            },
          ]}
        />
      </div>
      <h2 className="mt-2 truncate text-base font-semibold">
        <Link to={`/projects/${project.id}/annotate`} className="hover:underline">
          {project.name}
        </Link>
      </h2>
      <p className="mt-1 line-clamp-2 min-h-8 text-xs text-[var(--muted)]">
        {project.description || t('dashboard.subtitle')}
      </p>

      <ol className="mt-3 flex items-center gap-1.5" aria-label={t('dashboard.progress')}>
        {steps.map((step, index) => {
          const state = step.done ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li
              key={step.label}
              className="flex flex-1 flex-col items-center gap-1"
              title={step.label}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full border text-[10px]',
                  state === 'done' && 'border-transparent bg-[var(--accent)] text-[var(--accent-fg)]',
                  state === 'current' && 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent-subtle-fg)]',
                  state === 'todo' && 'border-[var(--border-strong)] text-[var(--muted)]',
                )}
              >
                {state === 'done' ? <Check className="size-3" aria-hidden /> : index + 1}
              </span>
              <span className="text-[10px] leading-tight text-[var(--muted)]">{step.label}</span>
            </li>
          );
        })}
      </ol>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        {[
          { label: t('common.images'), value: imageCount },
          { label: t('common.annotations'), value: annotationCount },
          { label: t('versions.title'), value: versionCount },
        ].map((stat) => (
          <div key={stat.label} className="rounded-md bg-[var(--surface-2)] p-1.5">
            <dt className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{stat.label}</dt>
            <dd className="font-mono font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--muted)]">
        <span>{t('dashboard.lastUpdated', { date: formatDate(project.updatedAt) })}</span>
        <Link
          to={`/projects/${project.id}/annotate`}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-[var(--accent)] hover:underline"
        >
          {t('dashboard.open')}
          <ArrowRight className="size-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [type, setType] = useState<ProjectType>('object-detection');
  const [classes, setClasses] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setName('');
      setClasses('');
      setType('object-detection');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      setError(t('newProject.nameRequired'));
      return;
    }
    setBusy(true);
    try {
      const project = await createProject({
        name,
        type,
        classes: classes
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      onOpenChange(false);
      onCreated(project);
    } finally {
      setBusy(false);
    }
  };

  return (
    <LazyDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('newProject.title')}
      description={t('newProject.description')}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            {t('newProject.create')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t('newProject.name')} htmlFor="project-name" error={error ?? undefined}>
          <Input
            id="project-name"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            placeholder={t('newProject.namePlaceholder')}
          />
        </Field>

        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">{t('newProject.type')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROJECT_TYPES.map((option) => (
              <label
                key={option}
                className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm ${
                  type === option ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]' : 'border-[var(--border)]'
                }`}
              >
                <input
                  type="radio"
                  name="project-type"
                  value={option}
                  checked={type === option}
                  onChange={() => setType(option)}
                  className="mt-1 accent-[var(--accent)]"
                />
                <span>
                  <span className="block font-medium">{t(`project.type.${option}` as const)}</span>
                  <span className="mt-0.5 block text-xs text-[var(--muted)]">
                    {t(`project.type.${option}.help` as const)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label={t('newProject.classes')} hint={t('newProject.classesHint')} htmlFor="project-classes">
          <Input
            id="project-classes"
            value={classes}
            onChange={(event) => setClasses(event.target.value)}
            placeholder="pallet, forklift, person"
          />
        </Field>
      </form>
    </LazyDialog>
  );
}