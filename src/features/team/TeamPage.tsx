import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { CheckCircle2, Circle, Copy, Users } from 'lucide-react';
import type { Project } from '@/core/types';
import { useT, useToast } from '@/ui/i18n';
import { Badge, Button, Card, Field, Spinner, Textarea } from '@/ui/primitives';
import { Page } from '@/features/shell/AppShell';
import { useCollab } from '@/collab/useCollab';
import { materialize } from '@/collab/state';
import type { ImageKey, Op } from '@/collab/types';

const CLAIM_BATCH = 10;
const VISIBLE_ROWS = 100;

/**
 * Team page: pairing, presence, and the work split.
 *
 * Everything here is derived from the replicated state, so the same numbers are
 * visible on every paired device. Images themselves never move through this
 * screen; only their content hashes and annotations do.
 */
export function TeamPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const { t } = useT();
  const { notify } = useToast();
  const { runtime, snapshot, error } = useCollab(project.id);

  const [offer, setOffer] = useState('');
  const [answerInput, setAnswerInput] = useState('');
  const [joinInput, setJoinInput] = useState('');
  const [joinAnswer, setJoinAnswer] = useState('');
  const [busy, setBusy] = useState<'invite' | 'join' | 'finish' | null>(null);

  const merged = useMemo(() => (snapshot ? materialize(snapshot.state) : null), [snapshot]);
  const images = useMemo(() => {
    if (!merged) return [];
    return [...merged.images.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt || (a[0] < b[0] ? -1 : 1));
  }, [merged]);

  const peer = runtime?.session.peer ?? '';
  const mine = useMemo(
    () => images.filter(([key]) => merged?.claims.get(key) === peer).map(([key]) => key),
    [images, merged, peer],
  );
  const unclaimed = useMemo(
    () => images.filter(([key]) => !merged?.claims.get(key)).map(([key]) => key),
    [images, merged],
  );
  const perPeer = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [key] of images) {
      const owner = merged?.claims.get(key);
      if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [images, merged]);
  const completed = useMemo(
    () => images.filter(([key]) => merged?.done.get(key) === true).length,
    [images, merged],
  );

  const short = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

  const submitClaim = (keys: ImageKey[], owner: string | null) => {
    if (!runtime || keys.length === 0) return;
    const ops: Op[] = keys.map((image) => {
      const s = runtime.session.nextStamp();
      return { oid: `${s.p}:${s.t}:img.claim`, k: 'img.claim', s, image, owner };
    });
    runtime.session.submit(ops);
  };

  const toggleDone = (key: ImageKey, done: boolean) => {
    if (!runtime) return;
    const s = runtime.session.nextStamp();
    runtime.session.submit([{ oid: `${s.p}:${s.t}:img.done`, k: 'img.done', s, image: key, done }]);
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ title: t('team.copied'), tone: 'success' });
    } catch {
      notify({ title: t('team.copyFailed'), tone: 'error' });
    }
  };

  const run = async (kind: 'invite' | 'join' | 'finish', action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (cause) {
      notify({
        title: t('team.error', { message: cause instanceof Error ? cause.message : String(cause) }),
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <Page>
        <p role="alert" className="text-sm text-[var(--error)]">
          {t('team.error', { message: error })}
        </p>
      </Page>
    );
  }

  if (!runtime || !snapshot || !merged) {
    return (
      <Page>
        <div className="grid place-items-center py-20">
          <Spinner className="size-6 text-[var(--muted)]" />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      </Page>
    );
  }

  const peers = snapshot.peers;
  const rows = images.slice(0, VISIBLE_ROWS);

  return (
    <Page>
      <header className="mb-6">
        <h1 className="text-lg font-semibold">{t('team.title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">{t('team.subtitle')}</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Users className="size-4" aria-hidden /> {t('team.peers')}
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--muted)]">{t('team.peerId')}</dt>
              <dd className="flex items-center gap-2">
                <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs">{short(peer)}</code>
                <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" aria-hidden />} onClick={() => void copy(peer)}>
                  {t('common.copy')}
                </Button>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--muted)]">{t('team.connected')}</dt>
              <dd>
                {peers.length === 0 ? (
                  <span className="text-[var(--muted)]">{t('team.solo')}</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {peers.map((candidate) => (
                      <Badge key={candidate} tone="success">
                        {short(candidate)}
                      </Badge>
                    ))}
                  </span>
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-[var(--muted)]">{t('team.sameBrowser')}</p>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold">{t('team.lanTitle')}</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">{t('team.lanHint')}</p>
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={busy === 'invite'}
                onClick={() =>
                  void run('invite', async () => {
                    setOffer(await runtime.createInvite());
                  })
                }
              >
                {t('team.invite')}
              </Button>
            </div>
            {offer ? (
              <Field label={t('team.invitePlaceholder')} htmlFor="team-offer">
                <Textarea id="team-offer" readOnly rows={3} value={offer} onFocus={(event) => event.currentTarget.select()} />
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => void copy(offer)}>
                  {t('common.copy')}
                </Button>
              </Field>
            ) : null}
            {offer ? (
              <Field label={t('team.answerPlaceholder')} htmlFor="team-answer-in">
                <Textarea
                  id="team-answer-in"
                  rows={3}
                  value={answerInput}
                  onChange={(event) => setAnswerInput(event.target.value)}
                />
                <Button
                  size="sm"
                  className="mt-2"
                  disabled={answerInput.trim().length === 0}
                  loading={busy === 'finish'}
                  onClick={() => void run('finish', async () => runtime.acceptAnswer(answerInput.trim()))}
                >
                  {t('team.finish')}
                </Button>
              </Field>
            ) : null}

            <Field label={t('team.joinPlaceholder')} htmlFor="team-join">
              <Textarea id="team-join" rows={3} value={joinInput} onChange={(event) => setJoinInput(event.target.value)} />
              <Button
                size="sm"
                className="mt-2"
                disabled={joinInput.trim().length === 0}
                loading={busy === 'join'}
                onClick={() => void run('join', async () => setJoinAnswer(await runtime.acceptInvite(joinInput.trim())))}
              >
                {t('team.join')}
              </Button>
            </Field>
            {joinAnswer ? (
              <Field label={t('team.answer')} htmlFor="team-answer-out">
                <Textarea id="team-answer-out" readOnly rows={3} value={joinAnswer} onFocus={(event) => event.currentTarget.select()} />
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => void copy(joinAnswer)}>
                  {t('common.copy')}
                </Button>
              </Field>
            ) : null}
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t('team.workSplit')}</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={unclaimed.length === 0}
              onClick={() => {
                submitClaim(unclaimed.slice(0, CLAIM_BATCH), peer);
                notify({ title: t('team.claimed', { count: Math.min(CLAIM_BATCH, unclaimed.length) }), tone: 'success' });
              }}
            >
              {t('team.claim', { count: CLAIM_BATCH })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={mine.length === 0}
              onClick={() => {
                submitClaim(mine, null);
                notify({ title: t('team.released'), tone: 'info' });
              }}
            >
              {t('team.release')}
            </Button>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: t('team.imagesTotal'), value: images.length },
            { label: t('team.unassigned'), value: unclaimed.length },
            { label: t('team.assignedToMe'), value: mine.length },
            { label: t('team.completed'), value: completed },
          ].map((stat) => (
            <div key={stat.label} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <dt className="text-xs text-[var(--muted)]">{stat.label}</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>

        {perPeer.length > 0 ? (
          <ul className="mt-4 flex flex-wrap gap-2 text-xs">
            {perPeer.map(([owner, count]) => (
              <li key={owner}>
                <Badge tone={owner === peer ? 'accent' : 'neutral'}>
                  {owner === peer ? t('team.you') : short(owner)} · {count}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}

        {images.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">{t('team.noImages')}</p>
        ) : (
          <>
            <table className="mt-4 w-full text-left text-sm">
              <caption className="sr-only">{t('team.workSplit')}</caption>
              <thead className="text-xs text-[var(--muted)]">
                <tr>
                  <th scope="col" className="py-1 font-medium">{t('team.image')}</th>
                  <th scope="col" className="py-1 font-medium">{t('team.owner')}</th>
                  <th scope="col" className="py-1 font-medium">{t('common.annotations')}</th>
                  <th scope="col" className="py-1 font-medium">{t('team.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([key, meta]) => {
                  const owner = merged.claims.get(key) ?? null;
                  const done = merged.done.get(key) === true;
                  const annotationCount = merged.annotationsByImage.get(key)?.length ?? 0;
                  return (
                    <tr key={key} className="border-t border-[var(--border)]">
                      <th scope="row" className="max-w-[28ch] truncate py-1.5 pr-3 font-normal">{meta.name}</th>
                      <td className="py-1.5 pr-3">
                        {owner === null ? (
                          <span className="text-[var(--muted)]">—</span>
                        ) : (
                          <Badge tone={owner === peer ? 'accent' : 'neutral'}>
                            {owner === peer ? t('team.you') : short(owner)}
                          </Badge>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums">{annotationCount}</td>
                      <td className="py-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={done ? <CheckCircle2 className="size-4 text-[var(--success)]" aria-hidden /> : <Circle className="size-4" aria-hidden />}
                          onClick={() => toggleDone(key, !done)}
                        >
                          {done ? t('team.markUndone') : t('team.markDone')}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {images.length > VISIBLE_ROWS ? (
              <p className="mt-2 text-xs text-[var(--muted)]">
                {t('team.showing', { shown: VISIBLE_ROWS, total: images.length })}
              </p>
            ) : null}
          </>
        )}
      </Card>
    </Page>
  );
}