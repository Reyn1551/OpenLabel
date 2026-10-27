/**
 * Copies text to the clipboard with a fallback for insecure contexts.
 *
 * `navigator.clipboard` is only available in a secure context. A self-hosted
 * instance served over plain HTTP on a LAN address (the common
 * `http://192.168.x.x:8080` case) would otherwise fail exactly where copying an
 * invite code matters most.
 */
export async function copyText(value: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied or not focused: fall back to the selection trick.
    }
  }
  if (typeof document === 'undefined') return false;

  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(area);
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return copied;
}