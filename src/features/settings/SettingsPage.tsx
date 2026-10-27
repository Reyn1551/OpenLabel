import { useEffect, useState } from 'react';
import { Database, Download, Globe2, Info, Moon, Palette, Sun, Trash2 } from 'lucide-react';
import { useSettings, type Locale, type ThemeMode } from '@/core/settings';
import { deleteProject, listProjects, storageEstimate } from '@/core/repo';
import { getDB } from '@/core/db';
import { useT, useToast } from '@/ui/i18n';
import { Button, Card, Spinner } from '@/ui/primitives';
import { Select } from '@/ui/heavy';
import { Page } from '@/features/shell/AppShell';
import { downloadBlob, formatBytes } from '@/lib/utils';

const THEMES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'settings.theme.system', icon: Globe2 },
  { value: 'light', label: 'settings.theme.light', icon: Sun },
  { value: 'dark', label: 'settings.theme.dark', icon: Moon },
];

export function SettingsPage() {
  const { t } = useT();
  const { notify } = useToast();
  const settings = useSettings();
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void storageEstimate().then(setStorage);
  }, [settings.theme]);

  const exportEverything = async () => {
    setBusy(true);
    try {
      const db = await getDB();
      const [projects, images, annotations, versions, models] = await Promise.all([
        db.getAll('projects'),
        db.getAll('images'),
        db.getAll('annotations'),
        db.getAll('versions'),
        db.getAll('models'),
      ]);
      const payload = {
        format: 'openlabel-workspace',
        version: 1,
        exportedAt: new Date().toISOString(),
        projects,
        images: images.map(({ descriptor: _descriptor, ...rest }) => rest),
        annotations,
        versions,
        models,
      };
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'openlabel-workspace.json');
      notify({ title: t('settings.exportAll'), tone: 'success' });
    } finally {
      setBusy(false);
    }
  };

  const deleteEverything = async () => {
    if (!window.confirm(t('settings.deleteAllConfirm'))) return;
    setBusy(true);
    try {
      const projects = await listProjects();
      for (const project of projects) await deleteProject(project.id);
      notify({ title: t('settings.deleteAll'), tone: 'info' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <header className="mb-5">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <Palette className="size-4" aria-hidden />
            {t('settings.appearance')}
          </h2>
          <fieldset className="mb-4">
            <legend className="mb-2 text-[13px] font-medium">{t('settings.theme')}</legend>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map((theme) => {
                const Icon = theme.icon;
                return (
                  <label
                    key={theme.value}
                    className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border p-3 text-xs ${
                      settings.theme === theme.value ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]' : 'border-[var(--border)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="theme"
                      className="sr-only"
                      checked={settings.theme === theme.value}
                      onChange={() => void settings.update({ theme: theme.value })}
                    />
                    <Icon className="size-4" aria-hidden />
                    {t(theme.label as 'settings.theme.system')}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className="mb-3 block space-y-1">
            <span className="text-[13px] font-medium">{t('settings.language')}</span>
            <Select<Locale>
              label={t('settings.language')}
              value={settings.locale}
              onChange={(value) => void settings.update({ locale: value })}
              options={[
                { value: 'en', label: 'English' },
                { value: 'id', label: 'Bahasa Indonesia' },
              ]}
            />
          </label>

          <label className="mb-3 block space-y-1">
            <span className="text-[13px] font-medium">{t('settings.density')}</span>
            <Select<'comfortable' | 'compact'>
              label={t('settings.density')}
              value={settings.density}
              onChange={(value) => void settings.update({ density: value })}
              options={[
                { value: 'comfortable', label: t('settings.density.comfortable') },
                { value: 'compact', label: t('settings.density.compact') },
              ]}
            />
          </label>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{t('settings.motion')}</span>
            <input
              type="checkbox"
              checked={settings.reduceMotion === 'on'}
              onChange={(event) => void settings.update({ reduceMotion: event.target.checked ? 'on' : 'system' })}
              className="size-4 accent-[var(--accent)]"
            />
          </label>
        </Card>

        <Card>
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
            <Database className="size-4" aria-hidden />
            {t('settings.data')}
          </h2>
          <p className="mb-3 text-xs text-[var(--muted)]">
            {storage
              ? `${t('settings.storage')}: ${formatBytes(storage.usage)} / ${formatBytes(storage.quota)}`
              : t('common.loading')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={busy ? <Spinner className="size-4" /> : <Download className="size-4" aria-hidden />}
              onClick={() => void exportEverything()}
              disabled={busy}
            >
              {t('settings.exportAll')}
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 className="size-4" aria-hidden />}
              onClick={() => void deleteEverything()}
              disabled={busy}
            >
              {t('settings.deleteAll')}
            </Button>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Info className="size-4" aria-hidden />
            {t('settings.about')}
          </h2>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-[var(--muted)]">{t('settings.version')}</dt>
              <dd className="font-mono">0.1.0</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">{t('app.name')}</dt>
              <dd>{t('app.tagline')}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Apache-2.0 · Local-first: images, annotations and models stay in this browser&apos;s IndexedDB.
          </p>
        </Card>
      </div>
    </Page>
  );
}