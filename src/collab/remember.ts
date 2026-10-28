import { getMeta, setMeta } from '@/core/repo';

/**
 * Remembers which projects this device joined, so they stay on the home page.
 *
 * A joined project is a real local replica: its images, annotations and classes
 * are in IndexedDB, so it keeps working offline after the first pairing. The
 * record adds what the replica cannot know by itself, namely how to reach the
 * host again for a live session.
 */
export interface JoinedProject {
  projectId: string;
  name: string;
  room?: string;
  host?: string;
  joinedAt: number;
}

const KEY = 'collab:joined';

export async function listJoined(): Promise<JoinedProject[]> {
  const stored = await getMeta<JoinedProject[]>(KEY);
  return Array.isArray(stored) ? stored : [];
}

export async function rememberJoined(
  projectId: string,
  extra: { room?: string; host?: string; name?: string } = {},
): Promise<void> {
  const existing = await listJoined();
  const previous = existing.find((entry) => entry.projectId === projectId);
  const next: JoinedProject = {
    projectId,
    name: extra.name ?? previous?.name ?? '',
    room: extra.room ?? previous?.room,
    host: extra.host ?? previous?.host,
    joinedAt: previous?.joinedAt ?? Date.now(),
  };
  const merged = [next, ...existing.filter((entry) => entry.projectId !== projectId)];
  await setMeta(KEY, merged);
}

export async function forgetJoined(projectId: string): Promise<void> {
  const existing = await listJoined();
  await setMeta(
    KEY,
    existing.filter((entry) => entry.projectId !== projectId),
  );
}

export async function getJoined(projectId: string): Promise<JoinedProject | undefined> {
  return (await listJoined()).find((entry) => entry.projectId === projectId);
}
