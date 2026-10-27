/**
 * Progressive enhancement for Chromium browsers: read a folder of images
 * directly from disk and write exports back, so large datasets never need to be
 * copied into IndexedDB and desktop-style LabelImg/LabelMe workflows stay possible.
 *
 * Every function reports `unsupported` instead of throwing when the API is
 * unavailable (Firefox, Safari, some embedded webviews).
 */

export interface DirectoryPickerSupport {
  supported: boolean;
  reason?: string;
}

export function directoryPickerSupport(): DirectoryPickerSupport {
  if (typeof window === 'undefined') return { supported: false, reason: 'No browser window' };
  const picker = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  return picker ? { supported: true } : { supported: false, reason: 'File System Access API is not available' };
}

interface AsyncDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

const IMAGE_PATTERN = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const MAX_FILES = 5000;

async function collectFiles(
  directory: FileSystemDirectoryHandle,
  prefix = '',
  out: File[] = [],
): Promise<File[]> {
  const iterable = directory as unknown as AsyncDirectoryHandle;
  for await (const [name, handle] of iterable.entries()) {
    if (out.length >= MAX_FILES) break;
    if (name.startsWith('.')) continue;
    if (handle.kind === 'directory') {
      await collectFiles(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, out);
    } else if (IMAGE_PATTERN.test(name)) {
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push(prefix ? new File([file], `${prefix}${name}`, { type: file.type || 'image/jpeg' }) : file);
    }
  }
  return out;
}

/** Lets the user choose a folder; returns image files, flattened with relative names. */
export async function pickImageFolder(): Promise<{ files: File[]; cancelled: boolean }> {
  const picker = (window as unknown as { showDirectoryPicker?: (options?: unknown) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (!picker) throw new Error('Folder access is unavailable in this browser');
  try {
    const directory = await picker({ mode: 'read', id: 'openlabel-images' });
    return { files: await collectFiles(directory), cancelled: false };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { files: [], cancelled: true };
    throw error;
  }
}

/** Writes export files into a folder the user picks (read-write permission). */
export async function saveFilesToFolder(
  files: { path: string; data: Uint8Array | string }[],
): Promise<{ saved: number; cancelled: boolean }> {
  const picker = (window as unknown as { showDirectoryPicker?: (options?: unknown) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (!picker) throw new Error('Folder access is unavailable in this browser');
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await picker({ mode: 'readwrite', id: 'openlabel-export' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { saved: 0, cancelled: true };
    throw error;
  }
  let saved = 0;
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const filename = parts.pop();
    if (!filename) continue;
    let target = directory;
    for (const part of parts) {
      target = await target.getDirectoryHandle(part, { create: true });
    }
    const handle = await target.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    const payload = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data;
    await writable.write(payload as unknown as BufferSource);
    await writable.close();
    saved += 1;
  }
  return { saved, cancelled: false };
}
