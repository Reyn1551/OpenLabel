import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Copy, Download, ImageUp, Play, Plus } from 'lucide-react';
import type { ImageMeta, ModelBundle, Prediction, Project } from '@/core/types';
import { getImageBlob, listImages, listModels } from '@/core/repo';
import { autoLabelClient } from '@/autolabel/client';
import { useT, useToast } from '@/ui/i18n';
import { copyText } from '@/lib/clipboard';
import { Badge, Button, Card, EmptyState, Spinner } from '@/ui/primitives';
import { Select } from '@/ui/heavy';
import { Page } from '@/features/shell/AppShell';
import { downloadBlob, formatPercent, safeFilename } from '@/lib/utils';

export function DeployPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const { t } = useT();
  const { notify } = useToast();
  const [model, setModel] = useState<ModelBundle | null | undefined>(undefined);
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [predictions, setPredictions] = useState<Prediction[] | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void Promise.all([listModels(project.id), listImages(project.id)]).then(([models, nextImages]) => {
      setModel(models[0] ?? null);
      setImages(nextImages);
      setSelectedId(nextImages[0]?.id ?? '');
    });
  }, [project.id]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const runInference = async () => {
    if (!model) return;
    let blob: Blob | undefined;
    let width = 0;
    let height = 0;
    let name = 'image';
    if (file) {
      blob = file;
      name = file.name;
    } else if (selectedId) {
      const image = images.find((item) => item.id === selectedId);
      if (!image) return;
      blob = await getImageBlob(image.id);
      width = image.width;
      height = image.height;
      name = image.name;
    }
    if (!blob) return;
    if (!width || !height) {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    }
    setBusy(true);
    setPredictions(null);
    try {
      const started = performance.now();
      const results = await autoLabelClient.predict({
        model,
        settings: project.autoLabel,
        images: [{ id: 'deploy', name, width, height, blob }],
      }).promise;
      setLatency(performance.now() - started);
      setPredictions(results[0]?.predictions ?? []);
    } catch (error) {
      notify({ title: error instanceof Error ? error.message : String(error), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const snippet = model
    ? `// OpenLabel portable model — ${model.classes.length} classes, ${model.dim}-dim descriptors\nconst model = await fetch('${safeFilename(project.name)}.model.json').then((r) => r.json());\n// score = softmax(model.weights · descriptor + model.bias)\n// See docs/AUTOLABEL.md for the descriptor definition and the full predictor.`
    : '';

  if (model === undefined) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-[var(--muted)]" />
      </div>
    );
  }

  if (!model) {
    return (
      <Page>
        <header className="mb-5">
          <h1 className="text-xl font-semibold">{t('deploy.title')}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('deploy.subtitle')}</p>
        </header>
        <EmptyState
          title={t('deploy.noModel')}
          description={t('autolabel.noModelHelp')}
          icon={<Play className="size-5" aria-hidden />}
        />
      </Page>
    );
  }

  return (
    <Page>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('deploy.title')}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('deploy.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Download className="size-4" aria-hidden />}
            onClick={() => {
              const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' });
              downloadBlob(blob, `${safeFilename(project.name)}.model.json`);
            }}
          >
            {t('deploy.downloadModel')}
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card className="space-y-3">
          <h2 className="text-sm font-semibold">{t('deploy.chooseImage')}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={<ImageUp className="size-4" aria-hidden />} onClick={() => fileRef.current?.click()}>
              {t('common.upload')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                event.target.value = '';
                setFile(next);
                setPredictions(null);
              }}
            />
            {images.length > 0 ? (
              <Select
                label={t('deploy.useCurrent')}
                value={selectedId}
                onChange={(value) => {
                  setSelectedId(value);
                  setFile(null);
                  setPredictions(null);
                }}
                options={images.map((image) => ({ value: image.id, label: image.name }))}
                className="h-10 max-w-64"
              />
            ) : null}
            <Button
              variant="primary"
              icon={busy ? <Spinner className="size-4" /> : <Play className="size-4" aria-hidden />}
              onClick={() => void runInference()}
              disabled={busy || (!file && !selectedId)}
            >
              {busy ? t('deploy.running') : t('deploy.run')}
            </Button>
          </div>

          <div className="checkerboard grid min-h-64 place-items-center overflow-hidden rounded-lg border border-[var(--border)]">
            <PreviewCanvas file={file} imageId={file ? null : selectedId} url={previewUrl} predictions={predictions} />
          </div>
          {latency !== null ? (
            <p className="text-xs text-[var(--muted)]">
              {t('deploy.latency')}: <span className="font-mono">{latency.toFixed(0)} ms</span>
            </p>
          ) : null}
        </Card>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 text-sm font-semibold">{t('deploy.metrics')}</h2>
            <div className="mb-2 flex flex-wrap gap-1">
              <Badge tone="accent">{t('deploy.trainedOn', { count: model.trainedOn })}</Badge>
              <Badge tone="success">F1 {formatPercent(model.metrics.f1, 0)}</Badge>
              <Badge>P {formatPercent(model.metrics.precision, 0)}</Badge>
              <Badge>R {formatPercent(model.metrics.recall, 0)}</Badge>
            </div>
            <ul className="flex flex-wrap gap-1">
              {model.classes.map((cls) => (
                <li
                  key={cls.id}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px]"
                >
                  <span className="size-2 rounded-full" style={{ backgroundColor: cls.color }} aria-hidden />
                  {cls.name}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-semibold">{t('deploy.output')}</h2>
            {predictions === null ? (
              <p className="text-xs text-[var(--muted)]">{t('autolabel.noPredictions')}</p>
            ) : predictions.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">{t('autolabel.noPredictions')}</p>
            ) : (
              <pre className="max-h-56 overflow-auto rounded-md bg-[var(--surface-2)] p-2 font-mono text-[11px]">
                {JSON.stringify(
                  predictions.map((prediction) => ({
                    class: model.classes.find((cls) => cls.id === prediction.classId)?.name ?? prediction.classId,
                    confidence: Number(prediction.score.toFixed(3)),
                    geometry: prediction.geometry,
                  })),
                  null,
                  2,
                )}
              </pre>
            )}
          </Card>

          <Card>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Plus className="size-4" aria-hidden />
              {t('deploy.snippet')}
            </h2>
            <p className="mt-1 text-[11px] text-[var(--muted)]">{t('deploy.snippetHelp')}</p>
            <pre className="mt-2 overflow-auto rounded-md bg-[var(--surface-2)] p-2 font-mono text-[11px]">{snippet}</pre>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              icon={<Copy className="size-4" aria-hidden />}
              onClick={() => {
                void copyText(snippet).then((copied) =>
                  notify({ title: copied ? t('common.copied') : t('team.copyFailed'), tone: copied ? 'success' : 'error' }),
                );
              }}
            >
              {t('common.copy')}
            </Button>
          </Card>
        </div>
      </div>
    </Page>
  );
}

function PreviewCanvas({
  file,
  imageId,
  url,
  predictions,
}: {
  file: File | null;
  imageId: string | null;
  url: string | null;
  predictions: Prediction[] | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const previous = useRef<ImageBitmap | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const blob = file ?? (imageId ? await getImageBlob(imageId) : undefined);
      if (!blob) {
        setBitmap(null);
        return;
      }
      const loaded = await createImageBitmap(blob);
      if (cancelled) {
        loaded.close();
        return;
      }
      setBitmap(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [file, imageId]);

  useEffect(() => {
    if (previous.current && previous.current !== bitmap) previous.current.close();
    previous.current = bitmap;
  }, [bitmap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = 640;
    const height = 480;
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    if (!bitmap) return;
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    const offsetX = (width - drawW) / 2;
    const offsetY = (height - drawH) / 2;
    ctx.drawImage(bitmap, offsetX, offsetY, drawW, drawH);
    if (!predictions || predictions.length === 0) return;
    for (const prediction of predictions) {
      ctx.save();
      ctx.strokeStyle = '#8b7cff';
      ctx.fillStyle = 'rgba(139, 124, 255, 0.16)';
      ctx.lineWidth = 2;
      const geometry = prediction.geometry;
      if (geometry.kind === 'bbox') {
        const x = offsetX + geometry.x * scale;
        const y = offsetY + geometry.y * scale;
        ctx.fillRect(x, y, geometry.width * scale, geometry.height * scale);
        ctx.strokeRect(x, y, geometry.width * scale, geometry.height * scale);
      } else if (geometry.kind === 'polygon') {
        ctx.beginPath();
        geometry.points.forEach((point, index) => {
          const x = offsetX + point.x * scale;
          const y = offsetY + point.y * scale;
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [bitmap, predictions]);

  if (!file && !imageId) {
    return <p className="p-6 text-xs text-[var(--muted)]">{url ? '' : 'Select an image to preview'}</p>;
  }

  return <canvas ref={canvasRef} className="max-h-80 w-full" aria-label="Inference preview" role="img" />;
}