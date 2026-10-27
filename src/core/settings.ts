import { create } from 'zustand';
import { getMeta, setMeta } from './repo';

export type ThemeMode = 'system' | 'light' | 'dark';
export type Locale = 'en' | 'id';
export type Density = 'comfortable' | 'compact';

export interface AppSettings {
  theme: ThemeMode;
  locale: Locale;
  density: Density;
  reduceMotion: 'system' | 'on';
  showConfidence: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  locale: 'en',
  density: 'comfortable',
  reduceMotion: 'system',
  showConfidence: true,
};

const MIRROR_KEY = 'openlabel.settings';

/** Reads the synchronous mirror so the first paint has the right theme. */
export function readMirroredSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function applySettingsToDocument(settings: AppSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', Boolean(dark));
  root.dataset.density = settings.density;
  root.lang = settings.locale;
  root.dataset.reduceMotion = settings.reduceMotion;
}

export interface SettingsStore extends AppSettings {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,
  hydrate: async () => {
    const stored = await getMeta<AppSettings>('settings');
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    applySettingsToDocument(settings);
    set({ ...settings, hydrated: true });
  },
  update: async (patch) => {
    const next = { ...get(), ...patch };
    const settings: AppSettings = {
      theme: next.theme,
      locale: next.locale,
      density: next.density,
      reduceMotion: next.reduceMotion,
      showConfidence: next.showConfidence,
    };
    applySettingsToDocument(settings);
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify(settings));
    } catch {
      /* storage can be unavailable in private mode; IndexedDB still works */
    }
    await setMeta('settings', settings);
    set(settings);
  },
}));

/** Keeps the theme in sync while the OS preference changes. */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (): void => {
    const { theme, ...rest } = useSettings.getState();
    if (theme === 'system') applySettingsToDocument({ theme, ...rest });
  };
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}