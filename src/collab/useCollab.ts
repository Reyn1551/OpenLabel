import { useEffect, useRef, useState } from 'react';
import { ensureCollab, type CollabRuntime } from './runtime';
import type { SessionSnapshot } from './session';

export interface CollabView {
  runtime: CollabRuntime | null;
  snapshot: SessionSnapshot | null;
  error: string | null;
}

/**
 * Opens (or reuses) the project's collaboration session and subscribes to its
 * merged view. The runtime outlives the component on purpose: navigating from
 * the team page to the studio must not drop connected peers.
 */
export function useCollab(projectId: string): CollabView {
  const [runtime, setRuntime] = useState<CollabRuntime | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRuntime(null);
    setSnapshot(null);
    setError(null);
    void ensureCollab(projectId)
      .then((value) => {
        if (cancelled) return;
        setRuntime(value);
        unsubscribe.current = value.session.subscribe(setSnapshot);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      unsubscribe.current?.();
      unsubscribe.current = null;
    };
  }, [projectId]);

  return { runtime, snapshot, error };
}