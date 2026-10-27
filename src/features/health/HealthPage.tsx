import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Copy, Images, Layers } from 'lucide-react';
import type { ImageMeta, Project } from '@/core/types';
import { assignSplit, listAnnotations, listImages } from '@/core/repo';
import { buildHealthReport, type HealthReport } from '@/core/health';
import { useT } from '@/ui/i18n';
import { Badge, Card, Spinner } from '@/ui/primitives';
import { Page } from '@/features/shell/AppShell';
import { formatPercent } from '@/lib/utils';
import { useThumb } from '@/features/studio/useThumb';

export function HealthPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const { t } = useT();
  const [images, setImages] = useState<ImageMeta[] | null>(null);
  const [report, setReport] = useState<HealthReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listImages(project.id), listAnnotations(project.id)]).then(([nextImages, nextAnnotations]) => {
      if (cancelled) return;
      setImages(nextImages);
      setReport(
        buildHealthReport(project, nextImages, nextAnnotations, (image) =>
          image.split ?? assignSplit(nextImages.indexOf(image), project.split),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  if (!report || !images) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-[var(--muted)]" />
      </div>
    );
  }

  const maxClass = Math.max(1, ...report.classCounts.map((item) => item.count));

  return (
    <Page>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">{t('health.title')}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{t('health.subtitle')}</p>
      </header>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('health.images')} value={report.imageCount} icon={<Images className="size-4" aria-hidden />} />
        <Stat label={t('health.annotations')} value={report.annotationCount} icon={<Layers className="size-4" aria-hidden />} />
        <Stat label={t('health.annotated')} value={report.annotatedImages} />
        <Stat label={t('health.unannotated')} value={report.unannotatedImages} tone={report.unannotatedImages > 0 ? 'warning' : 'success'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('health.balance')}</h2>
            <Badge tone={report.balanceScore > 0.7 ? 'success' : report.balanceScore > 0.4 ? 'warning' : 'error'}>
              {t('health.balanceScore')} {formatPercent(report.balanceScore, 0)}
            </Badge>
          </div>
          {report.classCounts.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">No classes yet.</p>
          ) : (
            <ul className="space-y-2">
              {report.classCounts.map((item) => (
                <li key={item.classId}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />
                      {item.name}
                    </span>
                    <span className="font-mono text-[var(--muted)]">{item.count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(item.count / maxClass) * 100}%`, backgroundColor: item.color }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">{t('health.split')}</h2>
          <div className="grid grid-cols-3 gap-2 text-center">
            {(['train', 'valid', 'test'] as const).map((split) => (
              <div key={split} className="rounded-lg bg-[var(--surface-2)] p-3">
                <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{split}</p>
                <p className="font-mono text-lg font-semibold">{report.splitCounts[split]}</p>
              </div>
            ))}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md border border-[var(--border)] p-2">
              <dt className="text-[var(--muted)]">{t('health.medianPerImage')}</dt>
              <dd className="font-mono">{report.annotationsPerImage.median}</dd>
            </div>
            <div className="rounded-md border border-[var(--border)] p-2">
              <dt className="text-[var(--muted)]">{t('health.tinyBoxes')}</dt>
              <dd className="font-mono">{report.tinyBoxes}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">{t('health.issues')}</h2>
          {report.issues.length === 0 ? (
            <p className="flex items-center gap-2 text-xs text-[var(--success)]">
              <CheckCircle2 className="size-4" aria-hidden />
              {t('health.noIssues')}
            </p>
          ) : (
            <ul className="space-y-2">
              {report.issues.map((issue, index) => (
                <li key={`${issue.title}-${index}`} className="rounded-lg border border-[var(--border)] p-2.5">
                  <p className="flex items-center gap-1.5 text-xs font-semibold">
                    <AlertTriangle
                      className={`size-3.5 ${issue.severity === 'error' ? 'text-[var(--error)]' : 'text-[var(--warning)]'}`}
                      aria-hidden
                    />
                    {issue.title}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">{issue.detail}</p>
                  <p className="mt-1 text-[11px]">
                    <span className="font-medium">{t('health.fix')}: </span>
                    {issue.fix}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">{t('health.duplicates')}</h2>
          {report.duplicates.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">{t('health.duplicatesNone')}</p>
          ) : (
            <ul className="space-y-2">
              {report.duplicates.slice(0, 6).map((group, index) => (
                <li key={index} className="rounded-lg border border-[var(--border)] p-2">
                  <p className="mb-1 text-[11px] text-[var(--muted)]">{t('health.duplicateGroup')}</p>
                  <div className="flex gap-1.5">
                    {group.imageIds.slice(0, 5).map((id) => (
                      <DuplicateThumb key={id} imageId={id} />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {report.recommendations.length > 0 ? (
        <Card className="mt-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Copy className="size-4" aria-hidden />
            {t('health.recommendations')}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--muted)]">
            {report.recommendations.map((recommendation) => (
              <li key={recommendation}>{recommendation}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Page>
  );
}

function Stat({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon?: React.ReactNode;
  tone?: 'success' | 'warning';
}) {
  return (
    <Card className="flex items-center gap-3">
      {icon ? <span className="grid size-9 place-items-center rounded-lg bg-[var(--surface-2)]">{icon}</span> : null}
      <div>
        <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</p>
        <p
          className={`font-mono text-xl font-semibold ${
            tone === 'warning' ? 'text-[var(--warning)]' : tone === 'success' ? 'text-[var(--success)]' : ''
          }`}
        >
          {value}
        </p>
      </div>
    </Card>
  );
}

function DuplicateThumb({ imageId }: { imageId: string }) {
  const url = useThumb(imageId);
  return (
    <span className="block size-14 overflow-hidden rounded border border-[var(--border)] bg-[var(--surface-2)]">
      {url ? <img src={url} alt="" className="size-full object-cover" /> : null}
    </span>
  );
}