import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { Project } from '@/core/types';
import { deleteProject, getProject, updateProject } from '@/core/repo';
import { useT } from '@/ui/i18n';
import { ensureCollab } from '@/collab/runtime';
import { Badge, Button, Dialog, Field, IconButton, Input, Menu, Spinner } from '@/ui/primitives';

export function ProjectShell() {
  const { projectId = '' } = useParams();
  const { t } = useT();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getProject(projectId).then((found) => {
      if (cancelled) return;
      setProject(found ?? null);
      setName(found?.name ?? '');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (project) document.title = `${project.name} · OpenLabel`;
  }, [project]);

  // The studio bridge must run while annotating, not only on the team page.
  useEffect(() => {
    void ensureCollab(projectId).catch(() => {
      // Collaboration is optional; the local studio keeps working without it.
    });
  }, [projectId]);

  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-[var(--muted)]" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="space-y-3">
          <p className="text-sm">Project not found.</p>
          <Button onClick={() => navigate('/')}>{t('nav.projects')}</Button>
        </div>
      </div>
    );
  }

  const tabs = [
    { to: 'annotate', label: t('studio.images') },
    { to: 'versions', label: t('versions.title') },
    { to: 'health', label: t('health.title') },
    { to: 'deploy', label: t('deploy.title') },
    { to: 'team', label: t('team.title') },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
        <IconButton label={t('nav.projects')} size="sm" onClick={() => navigate('/')}>
          <ChevronLeft className="size-4" aria-hidden />
        </IconButton>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="max-w-[40ch] truncate text-sm font-semibold">{project.name}</h1>
          <Badge tone="accent">{t(`project.type.${project.type}` as const)}</Badge>
        </div>
        <nav aria-label="Project sections" className="ml-auto flex items-center gap-1">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `rounded-md px-2.5 py-1.5 text-[13px] ${
                  isActive ? 'bg-[var(--surface-2)] font-medium text-[var(--fg)]' : 'text-[var(--muted)] hover:text-[var(--fg)]'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <Menu
          label="Project actions"
          trigger={
            <IconButton label="Project actions" size="sm">
              <MoreHorizontal className="size-4" aria-hidden />
            </IconButton>
          }
          items={[
            { label: t('common.rename'), icon: <Pencil className="size-4" aria-hidden />, onSelect: () => setRenaming(true) },
            {
              label: t('common.delete'),
              destructive: true,
              icon: <Trash2 className="size-4" aria-hidden />,
              onSelect: () => {
                if (!window.confirm(t('dashboard.deleteConfirm'))) return;
                void deleteProject(project.id).then(() => navigate('/'));
              },
            },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">
        <Outlet context={{ project, setProject }} />
      </div>

      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t('common.rename')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void updateProject(project.id, { name: name.trim() || project.name }).then((next) => {
                  setProject(next);
                  setRenaming(false);
                });
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Field label={t('newProject.name')} htmlFor="rename-project">
          <Input id="rename-project" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
      </Dialog>
    </div>
  );
}