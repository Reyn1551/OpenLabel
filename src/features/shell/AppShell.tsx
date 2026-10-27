import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Moon, Settings, Sun, WifiOff } from 'lucide-react';
import { useSettings } from '@/core/settings';
import { useT } from '@/ui/i18n';
import { IconButton, Menu, Tooltip } from '@/ui/primitives';

export function AppShell() {
  const { t } = useT();
  const theme = useSettings((state) => state.theme);
  const update = useSettings((state) => state.update);
  const location = useLocation();
  const navigate = useNavigate();
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (location.pathname === '/') document.title = 'OpenLabel';
  }, [location.pathname]);

  const toggleTheme = () => {
    void update({ theme: theme === 'dark' ? 'light' : 'dark' });
  };

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--fg)]">
      <a href="#main-content" className="skip-link">
        {t('nav.skip')}
      </a>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 sm:px-4">
        <Link to="/" className="flex items-center gap-2 rounded-md px-1 py-1 font-semibold">
          <span aria-hidden className="grid size-8 place-items-center">
            <img src={`${import.meta.env.BASE_URL}logo-light.svg`} alt="" width={32} height={32} className="size-8 dark:hidden" />
            <img src={`${import.meta.env.BASE_URL}logo-dark.svg`} alt="" width={32} height={32} className="hidden size-8 dark:block" />
          </span>
          <span className="text-[15px] tracking-tight">{t('app.name')}</span>
        </Link>
        <span className="hidden text-xs text-[var(--muted)] sm:inline">{t('app.tagline')}</span>

        <nav aria-label="Primary" className="ml-auto flex items-center gap-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `rounded-md px-2.5 py-1.5 text-[13px] ${isActive ? 'bg-[var(--surface-2)] font-medium' : 'text-[var(--muted)] hover:text-[var(--fg)]'}`
            }
          >
            {t('nav.projects')}
          </NavLink>
          <Tooltip label={online ? t('settings.offlineReady') : t('settings.offlineReady')}>
            <span className="mx-1 hidden items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted)] sm:flex">
              <WifiOff className="size-3" aria-hidden />
              {online ? 'Local-first' : 'Offline'}
            </span>
          </Tooltip>
          <IconButton label={theme === 'dark' ? t('settings.theme.light') : t('settings.theme.dark')} onClick={toggleTheme} size="sm">
            {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
          </IconButton>
          <Menu
            label="Application menu"
            trigger={
              <IconButton label={t('common.settings')} size="sm">
                <Settings className="size-4" aria-hidden />
              </IconButton>
            }
            items={[
              { label: t('nav.settings'), onSelect: () => navigate('/settings'), icon: <Settings className="size-4" aria-hidden /> },
            ]}
          />
        </nav>
      </header>
      <main id="main-content" className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

export function Page({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`h-full overflow-y-auto ${className}`}
      tabIndex={0}
      role="region"
      aria-label="Page content"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}
