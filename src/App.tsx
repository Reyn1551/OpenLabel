import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { I18nProvider, ToastProvider } from '@/ui/i18n';
import { Spinner } from '@/ui/primitives';
import { watchSystemTheme, useSettings } from '@/core/settings';
import { AppShell, Page } from '@/features/shell/AppShell';
import { ProjectShell } from '@/features/shell/ProjectShell';

/** Route-level code splitting keeps the first paint free of the annotation studio. */
function lazyNamed<T extends Record<string, React.ComponentType<never>>>(
  loader: () => Promise<T>,
  name: keyof T,
) {
  return lazy(async () => ({ default: (await loader())[name] as React.ComponentType }));
}

const DashboardPage = lazyNamed(() => import('@/features/dashboard/DashboardPage'), 'DashboardPage');
const StudioPage = lazyNamed(() => import('@/features/studio/StudioPage'), 'StudioPage');
const VersionsPage = lazyNamed(() => import('@/features/versions/VersionsPage'), 'VersionsPage');
const HealthPage = lazyNamed(() => import('@/features/health/HealthPage'), 'HealthPage');
const DeployPage = lazyNamed(() => import('@/features/deploy/DeployPage'), 'DeployPage');
const SettingsPage = lazyNamed(() => import('@/features/settings/SettingsPage'), 'SettingsPage');
const TeamPage = lazyNamed(() => import('@/features/team/TeamPage'), 'TeamPage');

export function App() {
  const hydrate = useSettings((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
    return watchSystemTheme();
  }, [hydrate]);

  return (
    <I18nProvider>
      <ToastProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Suspense
            fallback={
              <div className="grid h-dvh place-items-center">
                <Spinner className="size-6 text-[var(--muted)]" />
                <span className="sr-only">Loading</span>
              </div>
            }
          >
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="projects/:projectId" element={<ProjectShell />}>
                  <Route index element={<StudioPage />} />
                  <Route path="annotate" element={<StudioPage />} />
                  <Route path="versions" element={<VersionsPage />} />
                  <Route path="health" element={<HealthPage />} />
                  <Route path="deploy" element={<DeployPage />} />
                  <Route path="team" element={<TeamPage />} />
                </Route>
                <Route
                  path="*"
                  element={
                    <Page>
                      <div className="space-y-3 py-20 text-center">
                        <h1 className="text-xl font-semibold">Page not found</h1>
                        <Link to="/" className="text-[var(--accent)] underline">
                          Back to projects
                        </Link>
                      </div>
                    </Page>
                  }
                />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </I18nProvider>
  );
}
