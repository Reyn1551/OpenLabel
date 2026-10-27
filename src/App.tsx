import { useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { I18nProvider, ToastProvider } from '@/ui/i18n';
import { TooltipProvider } from '@/ui/primitives';
import { watchSystemTheme, useSettings } from '@/core/settings';
import { AppShell, Page } from '@/features/shell/AppShell';
import { ProjectShell } from '@/features/shell/ProjectShell';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { StudioPage } from '@/features/studio/StudioPage';
import { VersionsPage } from '@/features/versions/VersionsPage';
import { HealthPage } from '@/features/health/HealthPage';
import { DeployPage } from '@/features/deploy/DeployPage';
import { SettingsPage } from '@/features/settings/SettingsPage';

export function App() {
  const hydrate = useSettings((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
    return watchSystemTheme();
  }, [hydrate]);

  return (
    <I18nProvider>
      <ToastProvider>
        <TooltipProvider delayDuration={400}>
          <BrowserRouter basename={import.meta.env.BASE_URL}>
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
                </Route>
                <Route
                  path="*"
                  element={
                    <Page>
                      <div className="space-y-3 py-20 text-center">
                        <h1 className="text-xl font-semibold">Page not found</h1>
                        <Link to="/" className="text-sm text-[var(--accent)] underline">
                          Back to projects
                        </Link>
                      </div>
                    </Page>
                  }
                />
              </Route>
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
