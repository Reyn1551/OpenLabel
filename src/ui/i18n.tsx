import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { en, type Dictionary, type MessageKey } from '@/locales/en';
import { id } from '@/locales/id';
import { useSettings, type Locale } from '@/core/settings';

const DICTIONARIES: Record<Locale, Dictionary> = { en, id };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  t: Translate;
}

const I18nContext = createContext<I18nValue>({ locale: 'en', t: (key) => en[key] });

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useSettings((state) => state.locale);
  const value = useMemo<I18nValue>(() => {
    const dictionary = DICTIONARIES[locale] ?? en;
    const t: Translate = (key, vars) => {
      let message = dictionary[key] ?? en[key] ?? key;
      if (vars) {
        for (const [name, replacement] of Object.entries(vars)) {
          message = message.replaceAll(`{${name}}`, String(replacement));
        }
      }
      return message;
    };
    return { locale, t };
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  return useContext(I18nContext);
}

/* -------------------------------------------------------------------- toasts */

export interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: 'info' | 'success' | 'error';
}

interface ToastValue {
  toasts: Toast[];
  notify: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastValue>({ toasts: [], notify: () => {}, dismiss: () => {} });

let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const notify = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = ++toastId;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      const timer = setTimeout(() => dismiss(id), toast.tone === 'error' ? 8000 : 4200);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toasts, notify, dismiss }), [toasts, notify, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-12 left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastCard toast={toast} onDismiss={() => dismiss(toast.id)} />
          </div>
        ))}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <p key={toast.id}>
            {toast.title}. {toast.description}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const tone =
    toast.tone === 'error'
      ? 'border-[var(--error)]'
      : toast.tone === 'success'
        ? 'border-[var(--success)]'
        : 'border-[var(--border)]';
  return (
    <div className={`rounded-lg border ${tone} bg-[var(--surface)] p-3 shadow-xl`}>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <p className="text-sm font-medium">{toast.title}</p>
          {toast.description ? <p className="mt-0.5 text-xs text-[var(--muted)]">{toast.description}</p> : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 text-xs text-[var(--muted)] hover:bg-[var(--surface-2)]"
          aria-label="Dismiss notification"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function useToast(): ToastValue {
  return useContext(ToastContext);
}

/** Screen-reader announcement channel used by the annotation canvas. */
export function useAnnouncer() {
  const [message, setMessage] = useState('');
  const announce = useCallback((text: string) => {
    // Repeating the same string twice in a row would be ignored by some ATs.
    setMessage((current) => (current === text ? `${text} ` : text));
  }, []);
  const region = (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
  return { announce, region };
}

/** Unit-test seam: verifies every locale covers the English key set. */
export function translationCoverage(): { locale: Locale; missing: string[] }[] {
  return (Object.keys(DICTIONARIES) as Locale[]).map((locale) => ({
    locale,
    missing: (Object.keys(en) as MessageKey[]).filter((key) => !(key in DICTIONARIES[locale])),
  }));
}