import { useEffect, useMemo, useState } from 'react';
import { Check, Cpu, FlaskConical, Sparkles, X } from 'lucide-react';
import type { MessageKey } from '@/locales/en';
import { useStudio } from '@/core/store';
import { useT, useToast } from '@/ui/i18n';
import { Badge, Button, EmptyState } from '@/ui/primitives';
import { Progress, Slider, Switch } from '@/ui/heavy';
import { formatPercent } from '@/lib/utils';

const STAGE_KEYS: Record<string, MessageKey> = {
  features: 'autolabel.stage.features',
  training: 'autolabel.stage.training',
  validating: 'autolabel.stage.validating',
  finalizing: 'autolabel.stage.finalizing',
  predicting: 'autolabel.stage.predicting',
};

export function AutoLabelPanel() {
  const { t } = useT();
  const { notify } = useToast();
  const project = useStudio((state) => state.project);
  const images = useStudio((state) => state.images);
  const annotations = useStudio((state) => state.annotations);
  const selectedImageId = useStudio((state) => state.selectedImageId);
  const predictions = useStudio((state) => state.predictions);
  const model = useStudio((state) => state.model);
  const training = useStudio((state) => state.training);
  const batch = useStudio((state) => state.batch);
  const trainModel = useStudio((state) => state.trainModel);
  const predictImage = useStudio((state) => state.predictImage);
  const predictUnlabeled = useStudio((state) => state.predictUnlabeled);
  const acceptPrediction = useStudio((state) => state.acceptPrediction);
  const acceptAllPredictions = useStudio((state) => state.acceptAllPredictions);
  const discardPredictions = useStudio((state) => state.discardPredictions);
  const cancelJob = useStudio((state) => state.cancelJob);
  const updateAutoLabel = useStudio((state) => state.updateAutoLabel);
  const classes = project?.classes ?? [];

  const [autoAccept, setAutoAccept] = useState(false);
  const [threshold, setThreshold] = useState(project?.autoLabel.confidence ?? 0.55);

  useEffect(() => {
    if (project) setThreshold(project.autoLabel.confidence);
  }, [project?.id, project?.autoLabel.confidence]);

  const totals = useMemo(() => {
    const all = Object.values(annotations).flat();
    const perClass = new Map<string, number>();
    for (const annotation of all) {
      perClass.set(annotation.classId, (perClass.get(annotation.classId) ?? 0) + 1);
    }
    return { enabled: Boolean(project), total: all.length, perClass };
  }, [annotations, project]);

  const suggestions = selectedImageId ? predictions[selectedImageId] ?? [] : [];
  const unlabeled = images.filter((image) => (annotations[image.id] ?? []).length === 0).length;
  const required = project?.autoLabel.minAnnotations ?? 10;
  const progress = Math.min(1, totals.total / Math.max(1, required));
  const canTrain = totals.total > 0 && !training?.active;

  const onTrain = async (force: boolean) => {
    try {
      await trainModel({ force });
      const state = useStudio.getState();
      if (state.error) {
        notify({ title: t('autolabel.trainError', { message: state.error }), tone: 'error' });
        return;
      }
      if (state.model) {
        notify({
          title: t('autolabel.modelSaved', { count: state.model.trainedOn }),
          description:
            state.model.metrics.evaluated > 0
              ? `F1 ${formatPercent(state.model.metrics.f1)} on held-out images`
              : undefined,
          tone: 'success',
        });
      }
    } catch (error) {
      notify({ title: error instanceof Error ? error.message : String(error), tone: 'error' });
    }
  };

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-[var(--accent)]" aria-hidden />
          {t('autolabel.title')}
        </h2>
        <p className="text-xs text-[var(--muted)]">{t('autolabel.subtitle')}</p>
      </header>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-medium">
            {t('autolabel.progress', { count: totals.total, required })}
          </span>
          <span className="text-[var(--muted)]">{formatPercent(progress, 0)}</span>
        </div>
        <Progress value={progress} label={t('training.gate', { required })} />
        <p className="text-[11px] text-[var(--muted)]">
          {totals.total >= required
            ? t('autolabel.ready', { count: totals.total })
            : t('autolabel.needMore', { count: required - totals.total })}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={<Cpu className="size-4" aria-hidden />}
          onClick={() => void onTrain(false)}
          disabled={!canTrain || totals.total < required}
          loading={Boolean(training?.active)}
        >
          {training?.active ? t('autolabel.training') : model ? t('autolabel.retrain') : t('autolabel.train')}
        </Button>
        {totals.total > 0 && totals.total < required ? (
          <Button size="sm" variant="ghost" onClick={() => void onTrain(true)} disabled={!canTrain}>
            {t('autolabel.trainAnyway')}
          </Button>
        ) : null}
      </div>

      {training?.active ? (
        <div className="space-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
          <div className="flex items-center justify-between text-xs">
            <span>{t(STAGE_KEYS[training.stage] ?? 'autolabel.training')}</span>
            <span className="font-mono text-[var(--muted)]">{formatPercent(training.progress, 0)}</span>
          </div>
          <Progress value={training.progress} label={t('autolabel.training')} />
          <div className="flex justify-between text-[11px] text-[var(--muted)]">
            <span className="truncate">{training.message}</span>
            <button type="button" className="underline" onClick={cancelJob}>
              {t('autolabel.cancelRun')}
            </button>
          </div>
        </div>
      ) : null}

      {model ? (
        <section aria-label={t('autolabel.metrics')} className="space-y-2 rounded-lg border border-[var(--border)] p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              {t('autolabel.metrics')}
            </h3>
            <Badge tone="success">{t('autolabel.modelSaved', { count: model.trainedOn })}</Badge>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-center">
            {[
              ['autolabel.precision', model.metrics.precision],
              ['autolabel.recall', model.metrics.recall],
              ['autolabel.f1', model.metrics.f1],
            ].map(([key, value]) => (
              <div key={String(key)} className="rounded-md bg-[var(--surface-2)] p-2">
                <dt className="text-[11px] text-[var(--muted)]">{t(key as MessageKey)}</dt>
                <dd className="font-mono text-sm font-semibold">{formatPercent(Number(value))}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11px] text-[var(--muted)]">
            {t('autolabel.evaluated', { count: model.metrics.evaluated })}
          </p>
          {model.classes.some((cls) => (totals.perClass.get(cls.id) ?? 0) < 3) ? (
            <p className="text-[11px] text-[var(--warning)]">{t('autolabel.lowDataWarning')}</p>
          ) : null}

          <Slider
            label={t('autolabel.confidence')}
            value={threshold}
            min={0.1}
            max={0.95}
            step={0.01}
            onChange={setThreshold}
            onCommit={(value) => void updateAutoLabel({ confidence: value })}
            format={(value) => formatPercent(value, 0)}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<FlaskConical className="size-4" aria-hidden />}
              onClick={() => void predictImage()}
              disabled={!selectedImageId || Boolean(batch?.active)}
            >
              {t('autolabel.predictThis')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Sparkles className="size-4" aria-hidden />}
              onClick={() => void predictUnlabeled({ autoAccept })}
              disabled={unlabeled === 0 || Boolean(batch?.active)}
            >
              {t('autolabel.predictAll')} ({unlabeled})
            </Button>
          </div>
          <Switch
            checked={autoAccept}
            onChange={setAutoAccept}
            label={t('autolabel.autoAccept')}
            description={t('autolabel.autoAcceptHelp')}
          />
        </section>
      ) : (
        <EmptyState title={t('autolabel.noModel')} description={t('autolabel.noModelHelp')} icon={<Cpu className="size-5" aria-hidden />} />
      )}

      {batch?.active ? (
        <div className="space-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
          <div className="flex items-center justify-between text-xs">
            <span>{t('autolabel.stage.predicting')}</span>
            <span className="font-mono text-[var(--muted)]">{formatPercent(batch.progress, 0)}</span>
          </div>
          <Progress value={batch.progress} label={t('autolabel.predictAll')} />
          <div className="flex justify-between text-[11px] text-[var(--muted)]">
            <span className="truncate">{batch.message}</span>
            <button type="button" className="underline" onClick={cancelJob}>
              {t('autolabel.cancelRun')}
            </button>
          </div>
        </div>
      ) : null}

      <section aria-label={t('autolabel.predictions')} className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            {t('autolabel.predictions')} ({suggestions.length})
          </h3>
          {suggestions.length > 0 ? (
            <div className="flex gap-1">
              <Button size="sm" variant="success" onClick={() => selectedImageId && void acceptAllPredictions(selectedImageId)}>
                {t('autolabel.acceptAll')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => selectedImageId && void discardPredictions(selectedImageId)}>
                {t('autolabel.rejectAll')}
              </Button>
            </div>
          ) : null}
        </div>
        {suggestions.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">{t('autolabel.noPredictions')}</p>
        ) : (
          <ul className="space-y-1">
            {suggestions.map((prediction, index) => {
              const cls = classes.find((item) => item.id === prediction.classId);
              return (
                <li
                  key={`${prediction.classId}-${index}`}
                  className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1.5"
                >
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: cls?.color }} aria-hidden />
                  <span className="flex-1 truncate text-xs">{cls?.name ?? prediction.classId}</span>
                  <span className="font-mono text-[11px] text-[var(--muted)]">{formatPercent(prediction.score, 0)}</span>
                  <button
                    type="button"
                    className="rounded p-1 text-[var(--success)] hover:bg-[var(--surface-2)]"
                    aria-label={`${t('autolabel.accept')} ${cls?.name ?? ''}`}
                    onClick={() => selectedImageId && void acceptPrediction(selectedImageId, index)}
                  >
                    <Check className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-[var(--muted)] hover:bg-[var(--surface-2)]"
                    aria-label={`${t('autolabel.rejectAll')} ${cls?.name ?? ''}`}
                    onClick={() => selectedImageId && void discardPredictions(selectedImageId)}
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}