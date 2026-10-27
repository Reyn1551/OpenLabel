import { unzipSync } from 'fflate';
import type { ImageMeta } from './types';
import { computeDescriptor, computePHash, decodeImage, makeThumbnail } from './image';
import { putImages, uid, now } from './repo';

export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const IMAGE_MIMES = /^image\/(png|jpeg|webp|gif|bmp|avif)$/i;

export interface ImportProgress {
  done: number;
  total: number;
  message?: string;
}

export interface ImportResult {
  added: ImageMeta[];
  skipped: number;
  errors: { name: string; message: string }[];
}

async function sha256(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isImageFile(file: File): boolean {
  return IMAGE_MIMES.test(file.type) || IMAGE_EXTENSIONS.test(file.name);
}

/** Builds the complete metadata record for one image blob. */
export async function buildImageRecord(
  projectId: string,
  name: string,
  blob: Blob,
  batchId: string | null,
  knownHashes: Set<string>,
): Promise<{ meta: ImageMeta; blob: Blob; thumb: Blob } | null> {
  const hash = await sha256(blob);
  if (knownHashes.has(hash)) return null;
  knownHashes.add(hash);
  const decoded = await decodeImage(blob);
  try {
    const thumb = await makeThumbnail(decoded.bitmap, 384);
    const [pHash, descriptor] = await Promise.all([
      computePHash(decoded.bitmap),
      computeDescriptor(decoded.bitmap),
    ]);
    const record: ImageMeta = {
      id: uid('img'),
      projectId,
      name,
      width: decoded.width,
      height: decoded.height,
      bytes: blob.size,
      mime: blob.type || 'image/png',
      hash,
      createdAt: now(),
      tags: [],
      batchId,
      split: null,
      pHash,
      descriptor,
      annotationCount: 0,
      note: '',
    };
    return { meta: record, blob, thumb };
  } finally {
    decoded.bitmap.close();
  }
}

export async function importFiles(
  projectId: string,
  files: File[],
  options: {
    knownHashes?: Set<string>;
    onProgress?: (progress: ImportProgress) => void;
  } = {},
): Promise<ImportResult> {
  const known = options.knownHashes ?? new Set<string>();
  const batchId = uid('bat');
  const images: { meta: ImageMeta; blob: Blob; thumb: Blob }[] = [];
  const errors: { name: string; message: string }[] = [];
  let skipped = 0;
  const total = files.length;

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    options.onProgress?.({ done: index, total, message: file.name });
    try {
      if (!isImageFile(file)) {
        errors.push({ name: file.name, message: 'Unsupported file type' });
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        errors.push({ name: file.name, message: 'File is larger than the 40 MB limit' });
        continue;
      }
      const built = await buildImageRecord(projectId, file.name, file, batchId, known);
      if (!built) {
        skipped += 1;
        continue;
      }
      images.push(built);
    } catch (error) {
      errors.push({ name: file.name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  await putImages(images);
  options.onProgress?.({ done: total, total });
  return { added: images.map((item) => item.meta), skipped, errors };
}

/** Expands a zip archive (folders are flattened, junk entries ignored). */
export async function filesFromZip(zip: File): Promise<File[]> {
  const buffer = new Uint8Array(await zip.arrayBuffer());
  const entries = unzipSync(buffer);
  const files: File[] = [];
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith('/')) continue;
    const name = path.split('/').pop() ?? path;
    if (name.startsWith('.') || path.includes('__MACOSX')) continue;
    if (!IMAGE_EXTENSIONS.test(name)) continue;
    files.push(new File([data as BlobPart], name, { type: mimeForName(name) }));
  }
  return files;
}

export function mimeForName(name: string): string {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'avif':
      return 'image/avif';
    default:
      return 'image/jpeg';
  }
}

/** Accepts drop payloads: images, directories (via webkitGetAsEntry) and zips. */
export async function filesFromDataTransfer(data: DataTransfer): Promise<File[]> {
  const items = data.items;
  const collected: File[] = [];
  const files = Array.from(data.files);
  const entryFiles: File[] = [];
  if (items && items.length) {
    const readers: Promise<void>[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        readers.push(
          (async () => {
            const dirFiles = await readDirectory(entry as FileSystemDirectoryEntry);
            entryFiles.push(...dirFiles);
          })(),
        );
      }
    }
    await Promise.all(readers);
  }
  collected.push(...files, ...entryFiles);
  const images: File[] = [];
  for (const file of collected) {
    if (file.type === 'application/zip' || file.name.toLowerCase().endsWith('.zip')) {
      images.push(...(await filesFromZip(file)));
    } else {
      images.push(file);
    }
  }
  return images;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const { promise, resolve } = Promise.withResolvers<FileSystemEntry[]>();
  reader.readEntries(resolve, () => resolve([]));
  return promise;
}

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  const { promise, resolve } = Promise.withResolvers<File | null>();
  entry.file(resolve, () => resolve(null));
  return promise;
}

async function readDirectory(entry: FileSystemDirectoryEntry): Promise<File[]> {
  const reader = entry.createReader();
  const files: File[] = [];
  let batch = await readEntries(reader);
  while (batch.length > 0) {
    for (const child of batch) {
      if (child.isFile) {
        const file = await entryFile(child as FileSystemFileEntry);
        if (file) files.push(file);
      } else if (child.isDirectory) {
        files.push(...(await readDirectory(child as FileSystemDirectoryEntry)));
      }
    }
    batch = await readEntries(reader);
  }
  return files;
}

export async function importFromUrls(
  projectId: string,
  urls: string[],
  options: { knownHashes?: Set<string>; onProgress?: (progress: ImportProgress) => void } = {},
): Promise<ImportResult> {
  const known = options.knownHashes ?? new Set<string>();
  const batchId = uid('bat');
  const images: { meta: ImageMeta; blob: Blob; thumb: Blob }[] = [];
  const errors: { name: string; message: string }[] = [];
  let skipped = 0;
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index];
    options.onProgress?.({ done: index, total: urls.length, message: url });
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? `image_${index}.png`);
      const built = await buildImageRecord(projectId, name, blob, batchId, known);
      if (!built) {
        skipped += 1;
        continue;
      }
      images.push(built);
    } catch (error) {
      errors.push({ name: url, message: error instanceof Error ? error.message : String(error) });
    }
  }
  await putImages(images);
  return { added: images.map((i) => i.meta), skipped, errors };
}
