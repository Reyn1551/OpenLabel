import { useMemo, useState } from 'react';
import { FolderOpen, ImagePlus, Search, Trash2, Upload } from 'lucide-react';
import type { ImageMeta } from '@/core/types';
import { useStudio } from '@/core/store';
import { useT } from '@/ui/i18n';
import { Button, IconButton, Input, Menu, Select, Spinner } from '@/ui/primitives';
import { deleteImages } from '@/core/repo';
import { useThumb } from './useThumb';

type Filter = 'all' | 'unlabeled' | 'predictions';
type Sort = 'created' | 'name' | 'annotations';

export function ImageRail({
  onUpload,
  uploading,
  onOpenFolder,
}: {
  onUpload: () => void;
  uploading: boolean;
  onOpenFolder?: () => void;
}) {
  const { t } = useT();
  const images = useStudio((state) => state.images);
  const selectedImageId = useStudio((state) => state.selectedImageId);
  const predictions = useStudio((state) => state.predictions);
  const selectImage = useStudio((state) => state.selectImage);
  const refreshImages = useStudio((state) => state.refreshImages);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('created');

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const filtered = images.filter((image) => {
      if (term && !image.name.toLowerCase().includes(term) && !image.tags.some((tag) => tag.toLowerCase().includes(term))) {
        return false;
      }
      if (filter === 'unlabeled') return image.annotationCount === 0;
      if (filter === 'predictions') return (predictions[image.id] ?? []).length > 0;
      return true;
    });
    const sorted = [...filtered];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'annotations') sorted.sort((a, b) => b.annotationCount - a.annotationCount);
    else sorted.sort((a, b) => b.createdAt - a.createdAt);
    return sorted;
  }, [images, predictions, query, filter, sort]);

  const removeImage = async (image: ImageMeta) => {
    if (!window.confirm(`${t('common.delete')} ${image.name}?`)) return;
    await deleteImages(image.projectId, [image.id]);
    await refreshImages();
  };

  return (
    <section
      aria-label={t('studio.images')}
      className="flex h-full min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]"
    >
      <div className="space-y-2 border-b border-[var(--border)] p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">
            {t('studio.images')} <span className="font-normal text-[var(--muted)]">({images.length})</span>
          </h2>
          <Button
            size="sm"
            variant="primary"
            icon={<ImagePlus className="size-4" aria-hidden />}
            onClick={onUpload}
            loading={uploading}
          >
            {t('studio.addImages')}
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" aria-hidden />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('studio.filterSearch')}
            aria-label={t('studio.filterSearch')}
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select<Filter>
            label={t('studio.filterAll')}
            value={filter}
            onChange={setFilter}
            className="h-8 text-[13px]"
            options={[
              { value: 'all', label: t('studio.filterAll') },
              { value: 'unlabeled', label: t('studio.filterUnlabeled') },
              { value: 'predictions', label: 'Suggestions' },
            ]}
          />
          <Select<Sort>
            label={t('studio.sort')}
            value={sort}
            onChange={setSort}
            className="h-8 text-[13px]"
            options={[
              { value: 'created', label: t('studio.sort.created') },
              { value: 'name', label: t('studio.sort.name') },
              { value: 'annotations', label: t('studio.sort.annotations') },
            ]}
          />
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t('studio.images')}>
        {visible.map((image) => {
          const selected = image.id === selectedImageId;
          const suggestionCount = (predictions[image.id] ?? []).length;
          return (
            <li key={image.id} className="relative">
              <div
                className={`group flex w-full items-center gap-2 rounded-lg border p-1.5 text-left transition-colors ${
                  selected
                    ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]'
                    : 'border-transparent hover:bg-[var(--surface-2)]'
                }`}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => selectImage(image.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <Thumb imageId={image.id} name={image.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium">{image.name}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-[var(--muted)]">
                      <span>
                        {image.annotationCount}{' '}
                        {t(image.annotationCount === 1 ? 'common.annotation.one' : 'common.annotation.other')}
                      </span>
                      {suggestionCount > 0 ? (
                        <span className="rounded-full bg-[color-mix(in_oklab,var(--accent)_20%,transparent)] px-1.5 text-[10px] text-[var(--fg)]">
                          {suggestionCount} auto
                        </span>
                      ) : null}
                      {image.tags.slice(0, 2).map((tag) => (
                        <span key={tag} className="rounded-full bg-[var(--surface-2)] px-1.5 text-[10px]">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
                <Menu
                  label={`Actions for ${image.name}`}
                  trigger={
                    <IconButton label={`Actions for ${image.name}`} size="sm" className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <span aria-hidden>⋯</span>
                    </IconButton>
                  }
                  items={[
                    {
                      label: t('common.delete'),
                      destructive: true,
                      icon: <Trash2 className="size-4" aria-hidden />,
                      onSelect: () => void removeImage(image),
                    },
                  ]}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {visible.length === 0 ? (
        <p className="px-3 pb-4 text-xs text-[var(--muted)]">
          {images.length === 0 ? t('studio.noImagesDescription') : 'No images match this filter.'}
        </p>
      ) : null}

      <div className="space-y-1 border-t border-[var(--border)] p-2">
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start"
          icon={uploading ? <Spinner className="size-4" /> : <Upload className="size-4" aria-hidden />}
          onClick={onUpload}
        >
          {t('studio.addImages')}
        </Button>
        {onOpenFolder ? (
          <Button
            size="sm"
            variant="ghost"
            className="w-full justify-start"
            icon={<FolderOpen className="size-4" aria-hidden />}
            onClick={onOpenFolder}
            title={t('studio.openFolderHint')}
          >
            {t('studio.openFolder')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function Thumb({ imageId, name }: { imageId: string; name: string }) {
  const url = useThumb(imageId);
  return (
    <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded border border-[var(--border)] bg-[var(--surface-2)]">
      {url ? (
        <img src={url} alt="" width={40} height={40} className="size-full object-cover" loading="lazy" />
      ) : (
        <span className="text-[10px] text-[var(--muted)]" aria-hidden>
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}