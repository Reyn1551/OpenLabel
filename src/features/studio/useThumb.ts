import { useEffect, useState } from 'react';
import { getImageBlob, getImageThumb } from '@/core/repo';

/** Loads (and revokes) an object URL for one image thumbnail. */
export function useThumb(imageId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    if (!imageId) return () => {};
    void getImageThumb(imageId).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);
  return url;
}

export function useImageBitmap(imageId: string | null): { bitmap: ImageBitmap | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ bitmap: ImageBitmap | null; loading: boolean; error: string | null }>({
    bitmap: null,
    loading: Boolean(imageId),
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    let loaded: ImageBitmap | null = null;
    setState({ bitmap: null, loading: Boolean(imageId), error: null });
    if (!imageId) return () => {};
    void (async () => {
      try {
        const blob = await getImageBlob(imageId);
        if (!blob) throw new Error('Image data missing');
        loaded = await createImageBitmap(blob);
        if (cancelled) {
          loaded.close();
          return;
        }
        setState({ bitmap: loaded, loading: false, error: null });
      } catch (error) {
        if (!cancelled) {
          setState({ bitmap: null, loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
      loaded?.close();
    };
  }, [imageId]);
  return state;
}
