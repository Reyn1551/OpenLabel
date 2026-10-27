import { useEffect, useState } from 'react';
import type { ClassDef, ProjectType } from '@/core/types';
import { Button, Field, Input } from '@/ui/primitives';
import { Dialog } from '@/ui/heavy';
import { useT } from '@/ui/i18n';

export function ClassDialog({
  open,
  onOpenChange,
  projectType,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectType: ProjectType;
  onCreate: (name: string, keypoints?: string[]) => Promise<ClassDef | null>;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [keypoints, setKeypoints] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setName('');
      setKeypoints('');
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    await onCreate(
      name,
      keypoints
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
    setBusy(false);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('studio.addClass')}
      description={t('studio.activeClass')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!name.trim()} loading={busy}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t('studio.className')} htmlFor="class-name">
          <Input
            id="class-name"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            placeholder="pallet"
          />
        </Field>
        {projectType === 'keypoint' ? (
          <Field label={t('studio.keypointSkeleton')} hint={t('studio.keypointSkeletonHint')} htmlFor="class-keypoints">
            <Input
              id="class-keypoints"
              value={keypoints}
              onChange={(event) => setKeypoints(event.target.value)}
              placeholder="nose, left_eye, right_eye"
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}