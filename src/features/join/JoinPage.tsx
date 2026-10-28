import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Copy, Link2, TriangleAlert } from 'lucide-react';
import { ensureProjectShell } from '@/core/repo';
import { useT } from '@/ui/i18n';
import { Button, Card, Field, Spinner, Textarea } from '@/ui/primitives';
import { Page } from '@/features/shell/AppShell';
import { ensureCollab } from '@/collab/runtime';
import { rememberJoined } from '@/collab/remember';
import { copyText } from '@/lib/clipboard';

/**
 * Handles a one-click invite link.
 *
 * An invite link points at `localhost` on purpose: every device runs its own
 * `npx openlabel`, so the link opens the same app on the device that receives
 * it, and the answer comes back as a second link. Nothing is hosted and no
 * third party sees the codes.
 *
 * The device that created the invite must paste the reply link into its Team
 * tab, because a WebRTC offer only lives in the tab that produced it. Opening
 * the reply link in a fresh tab cannot resume that connection.
 */
export function JoinPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useT();
  const [replyLink, setReplyLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  const code = params.get('c') ?? '';
  const room = params.get('room') ?? '';
  const host = params.get('host') ?? '';
  const projectId = params.get('p') ?? '';
  const name = params.get('n') ?? '';
  const isReply = params.get('r') === '1';

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if ((!code && !room) || !projectId) {
      setError(t('join.badLink'));
      return;
    }

    if (room) {
      // One-click flow: ask the host's instance for its offer, answer it, and
      // post the answer back through our own instance. No paste required.
      void (async () => {
        try {
          await ensureProjectShell({ id: projectId, name: name || undefined });
          const runtime = await ensureCollab(projectId);
          await runtime.joinRoom(room, host);
          await rememberJoined(projectId, { room, host, name });
          navigate(`/projects/${projectId}/team?joined=1`, { replace: true });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
      return;
    }

    if (isReply) {
      // Hand the code to the Team page of the project that created the invite.
      navigate(`/projects/${projectId}/team?answer=${encodeURIComponent(code)}`, { replace: true });
      return;
    }

    void (async () => {
      try {
        await ensureProjectShell({ id: projectId, name: name || undefined });
        const runtime = await ensureCollab(projectId);
        setReplyLink(await runtime.acceptInviteLink(code));
        await rememberJoined(projectId, { name });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [code, room, host, projectId, name, isReply, navigate, t]);

  const copy = async () => {
    const ok = await copyText(replyLink);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Page>
      <Card className="mx-auto mt-10 max-w-xl">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Link2 className="size-4" aria-hidden /> {t('join.title')}
        </h1>

        {error ? (
          <div className="mt-3 space-y-3">
            <p role="alert" className="flex items-start gap-2 text-sm text-[var(--error)]">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
            <Button size="sm" onClick={() => navigate('/')}>
              {t('join.back')}
            </Button>
          </div>
        ) : replyLink ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-[var(--muted)]">{t('join.sendBack')}</p>
            <Field label={t('join.replyLink')} htmlFor="join-reply">
              <Textarea id="join-reply" readOnly rows={3} value={replyLink} onFocus={(event) => event.currentTarget.select()} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />} onClick={() => void copy()}>
                {copied ? t('join.copied') : t('common.copy')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/projects/${projectId}/team`)}>
                {t('join.openTeam')}
              </Button>
            </div>
            <p className="text-xs text-[var(--muted)]">{t('join.dataNote')}</p>
          </div>
        ) : (
          <div className="mt-6 grid place-items-center py-10">
            <Spinner className="size-6 text-[var(--muted)]" />
            <span className="sr-only">{t('join.connecting')}</span>
            <p className="mt-3 text-sm text-[var(--muted)]">{t('join.connecting')}</p>
          </div>
        )}
      </Card>
    </Page>
  );
}
