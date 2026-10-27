import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, ClassDef, Geometry, ImageMeta, Point, Prediction } from '@/core/types';
import {
  bboxHandles,
  clamp,
  distanceToSegment,
  pointInPolygon,
  polygonArea,
  resizeBox,
  simplifyPolygon,
  translateGeometry,
} from '@/core/geometry';
import type { Tool } from '@/core/store';
import { magicWandPolygon, downscaleForSelection } from '@/core/segment';
import type { RGBAImage } from '@/autolabel/features';
import { useT } from '@/ui/i18n';

interface CanvasStageProps {
  image: ImageMeta;
  bitmap: ImageBitmap | null;
  annotations: Annotation[];
  classes: ClassDef[];
  selectedId: string | null;
  tool: Tool;
  activeClassId: string | null;
  zoom: number;
  pan: Point;
  showAnnotations: boolean;
  showConfidence: boolean;
  predictions: Prediction[];
  fitNonce: number;
  onSelect: (id: string | null) => void;
  onCreate: (geometry: Geometry) => void;
  onUpdate: (id: string, geometry: Geometry, commit: boolean) => void;
  onBeginEdit: () => void;
  onDeleteSelected: () => void;
  onTransform: (zoom: number, pan: Point) => void;
  onViewport: (width: number, height: number) => void;
}

type Interaction =
  | { mode: 'idle' }
  | { mode: 'pan'; start: Point; pan0: Point }
  | { mode: 'draw-box'; start: Point; current: Point }
  | { mode: 'move'; id: string; start: Point; original: Geometry }
  | { mode: 'resize'; id: string; handle: number; original: Geometry; start: Point }
  | { mode: 'vertex'; id: string; index: number; original: Geometry }
  | { mode: 'freehand'; points: Point[] }
  | { mode: 'wand'; point: Point };

const HANDLE_RADIUS = 7;
const HIT_SLOP = 6;

export function CanvasStage(props: CanvasStageProps) {
  const {
    image,
    bitmap,
    annotations,
    classes,
    selectedId,
    tool,
    activeClassId,
    zoom,
    pan,
    showAnnotations,
    showConfidence,
    predictions,
    fitNonce,
    onSelect,
    onCreate,
    onUpdate,
    onBeginEdit,
    onDeleteSelected,
    onTransform,
    onViewport,
  } = props;
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageDataRef = useRef<{ image: RGBAImage; scale: number } | null>(null);
  const interaction = useRef<Interaction>({ mode: 'idle' });
  const spaceDown = useRef(false);
  const [draftPolygon, setDraftPolygon] = useState<Point[]>([]);
  const [draftKeypoints, setDraftKeypoints] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [keyboardPlacement, setKeyboardPlacement] = useState<{
    start: Point;
    current: Point;
    startFixed: boolean;
  } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [version, setVersion] = useState(0);

  const classMap = useMemo(() => new Map(classes.map((cls) => [cls.id, cls])), [classes]);
  const activeClass = activeClassId ? classMap.get(activeClassId) : undefined;
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

  const toImage = useCallback(
    (screenX: number, screenY: number): Point => ({
      x: (screenX - pan.x) / zoom,
      y: (screenY - pan.y) / zoom,
    }),
    [pan.x, pan.y, zoom],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      onViewport(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [onViewport]);

  const fitToScreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    const scale = Math.min(cw / image.width, ch / image.height) * 0.94;
    onTransform(scale, {
      x: (cw - image.width * scale) / 2,
      y: (ch - image.height * scale) / 2,
    });
  }, [image.width, image.height, onTransform]);

  useEffect(() => {
    fitToScreen();
    // Fit is requested explicitly or when the image changes; zooming must not refit.
  }, [fitToScreen, fitNonce, image.id]);

  // Native wheel listener so pinch/trackpad zoom can prevent page scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextZoom = clamp(zoom * factor, 0.05, 16);
      const point = { x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom };
      onTransform(nextZoom, { x: sx - point.x * nextZoom, y: sy - point.y * nextZoom });
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [zoom, pan.x, pan.y, onTransform]);

  const ensureImageData = useCallback((): RGBAImage | null => {
    if (!bitmap) return null;
    if (imageDataRef.current) return imageDataRef.current.image;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const scaled = downscaleForSelection(
      { data: data.data, width: data.width, height: data.height },
      1280,
    );
    imageDataRef.current = scaled;
    return scaled.image;
  }, [bitmap]);

  useEffect(() => {
    imageDataRef.current = null;
    setDraftPolygon([]);
    setDraftKeypoints([]);
    setKeyboardPlacement(null);
    interaction.current = { mode: 'idle' };
  }, [image.id]);

  /* --------------------------------------------------------------- drawing */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = Math.max(1, Math.round(size.width * dpr));
    canvas.height = Math.max(1, Math.round(size.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    if (bitmap) {
      ctx.imageSmoothingEnabled = zoom < 2;
      ctx.drawImage(bitmap, pan.x, pan.y, image.width * zoom, image.height * zoom);
    }

    if (!showAnnotations) return;

    const screen = (p: Point): Point => ({ x: pan.x + p.x * zoom, y: pan.y + p.y * zoom });

    // Suggestions are drawn under committed annotations.
    for (const prediction of predictions) {
      const color = classMap.get(prediction.classId)?.color ?? '#f59e0b';
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.fillStyle = `color-mix(in oklab, ${color} 14%, transparent)`;
      if (prediction.geometry.kind === 'bbox') {
        const p = screen({ x: prediction.geometry.x, y: prediction.geometry.y });
        ctx.fillRect(p.x, p.y, prediction.geometry.width * zoom, prediction.geometry.height * zoom);
        ctx.strokeRect(p.x, p.y, prediction.geometry.width * zoom, prediction.geometry.height * zoom);
      } else if (prediction.geometry.kind === 'polygon') {
        ctx.beginPath();
        prediction.geometry.points.forEach((point, index) => {
          const p = screen(point);
          if (index === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const annotation of annotations) {
      const cls = classMap.get(annotation.classId);
      const color = cls?.color ?? '#94a3b8';
      const selected = annotation.id === selectedId;
      const geometry = annotation.geometry;
      ctx.save();
      ctx.lineWidth = selected ? 2.5 : 1.75;
      ctx.strokeStyle = color;
      ctx.fillStyle = `color-mix(in oklab, ${color} 12%, transparent)`;
      ctx.setLineDash(annotation.source === 'auto' ? [5, 4] : []);

      if (geometry.kind === 'bbox') {
        const p = screen({ x: geometry.x, y: geometry.y });
        const w = geometry.width * zoom;
        const h = geometry.height * zoom;
        ctx.fillRect(p.x, p.y, w, h);
        ctx.strokeRect(p.x, p.y, w, h);
        drawChip(ctx, labelFor(annotation, cls, showConfidence, t), p.x, p.y - 2, color);
        if (selected) drawHandles(ctx, p.x, p.y, w, h, color);
      } else if (geometry.kind === 'polygon' || geometry.kind === 'polyline') {
        ctx.beginPath();
        geometry.points.forEach((point, index) => {
          const p = screen(point);
          if (index === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        if (geometry.kind === 'polygon') {
          ctx.closePath();
          ctx.fill();
        }
        ctx.stroke();
        const anchor = screen(geometry.points[0]);
        drawChip(ctx, labelFor(annotation, cls, showConfidence, t), anchor.x, anchor.y - 2, color);
        if (selected) {
          ctx.setLineDash([]);
          for (const point of geometry.points) {
            const p = screen(point);
            ctx.beginPath();
            ctx.fillStyle = color;
            ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#0b0d12';
            ctx.stroke();
          }
        }
      } else {
        const points = geometry.points;
        ctx.setLineDash([]);
        if (points.length > 1) {
          ctx.beginPath();
          points.forEach((point, index) => {
            const p = screen(point);
            if (index === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          });
          ctx.stroke();
        }
        points.forEach((point, index) => {
          const p = screen(point);
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.arc(p.x, p.y, selected ? 6 : 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#0b0d12';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          if (selected && cls?.keypoints?.[index]) {
            drawChip(ctx, cls.keypoints[index], p.x + 7, p.y - 7, color);
          }
        });
        const anchor = points[0] ? screen(points[0]) : null;
        if (anchor) drawChip(ctx, labelFor(annotation, cls, showConfidence, t), anchor.x, anchor.y - 10, color);
      }
      ctx.restore();
    }

    // In-progress interactions.
    const active = interaction.current;
    ctx.save();
    ctx.strokeStyle = 'var(--accent)';
    ctx.lineWidth = 1.75;
    ctx.setLineDash([5, 4]);
    if (active.mode === 'draw-box') {
      const a = screen(active.start);
      const b = screen(active.current);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    if (active.mode === 'freehand' && active.points.length > 1) {
      ctx.beginPath();
      active.points.forEach((point, index) => {
        const p = screen(point);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    ctx.restore();

    if (draftPolygon.length > 0) {
      ctx.save();
      ctx.strokeStyle = 'var(--accent)';
      ctx.fillStyle = 'rgba(124, 92, 255, 0.12)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      draftPolygon.forEach((point, index) => {
        const p = screen(point);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (cursor) {
        const p = screen(cursor);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      if (draftPolygon.length > 2) ctx.fill();
      ctx.setLineDash([]);
      for (const point of draftPolygon) {
        const p = screen(point);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'var(--accent)';
        ctx.fill();
      }
      ctx.restore();
    }

    if (draftKeypoints.length > 0) {
      ctx.save();
      for (const point of draftKeypoints) {
        const p = screen(point);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = 'var(--accent)';
        ctx.fill();
      }
      ctx.restore();
    }

    if (keyboardPlacement) {
      const a = screen(keyboardPlacement.start);
      const b = screen(keyboardPlacement.current);
      ctx.save();
      ctx.strokeStyle = 'var(--accent)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(b.x, b.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'var(--accent)';
      ctx.fill();
      ctx.restore();
    }
  }, [
    annotations,
    bitmap,
    classMap,
    cursor,
    draftKeypoints,
    draftPolygon,
    dpr,
    image.height,
    image.width,
    keyboardPlacement,
    pan.x,
    pan.y,
    predictions,
    selectedId,
    showAnnotations,
    showConfidence,
    size.height,
    size.width,
    t,
    version,
    zoom,
  ]);

  /* ------------------------------------------------------------ hit testing */

  const hitTest = useCallback(
    (point: Point): { annotation: Annotation; vertex?: number } | null => {
      const slop = HIT_SLOP / zoom;
      for (let index = annotations.length - 1; index >= 0; index--) {
        const annotation = annotations[index];
        const geometry = annotation.geometry;
        if (geometry.kind === 'bbox') {
          if (
            point.x >= geometry.x - slop &&
            point.x <= geometry.x + geometry.width + slop &&
            point.y >= geometry.y - slop &&
            point.y <= geometry.y + geometry.height + slop
          ) {
            return { annotation };
          }
        } else if (geometry.kind === 'polygon') {
          if (pointInPolygon(point, geometry.points)) return { annotation };
          for (let i = 0; i < geometry.points.length; i++) {
            const a = geometry.points[i];
            const b = geometry.points[(i + 1) % geometry.points.length];
            if (distanceToSegment(point, a, b) <= slop) return { annotation, vertex: i };
          }
        } else {
          for (let i = 0; i < geometry.points.length; i++) {
            if (Math.hypot(point.x - geometry.points[i].x, point.y - geometry.points[i].y) <= 8 / zoom) {
              return { annotation, vertex: i };
            }
          }
        }
      }
      return null;
    },
    [annotations, zoom],
  );

  const handleHit = useCallback(
    (point: Point): { id: string; handle: number } | null => {
      if (!selectedId) return null;
      const annotation = annotations.find((item) => item.id === selectedId);
      if (!annotation || annotation.geometry.kind !== 'bbox') return null;
      const handles = bboxHandles(annotation.geometry);
      const radius = HANDLE_RADIUS / zoom;
      for (const handle of handles) {
        if (Math.hypot(point.x - handle.point.x, point.y - handle.point.y) <= radius) {
          return { id: annotation.id, handle: handle.index };
        }
      }
      return null;
    },
    [annotations, selectedId, zoom],
  );

  /* -------------------------------------------------------------- pointers */

  const closePolygon = useCallback(
    (points: Point[]) => {
      if (points.length >= 3 && polygonArea(points) > 4) {
        onCreate({ kind: 'polygon', points });
      }
      setDraftPolygon([]);
    },
    [onCreate],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const point = toImage(screenPoint.x, screenPoint.y);

    if (event.button === 1 || tool === 'pan' || spaceDown.current) {
      interaction.current = { mode: 'pan', start: screenPoint, pan0: pan };
      setVersion((v) => v + 1);
      return;
    }
    if (event.button !== 0) return;

    if (tool === 'wand') {
      const data = ensureImageData();
      if (!data) return;
      const scale = imageDataRef.current?.scale ?? 1;
      const polygon = magicWandPolygon(data, { x: point.x * scale, y: point.y * scale }, 26);
      if (polygon.length >= 3) {
        onCreate({ kind: 'polygon', points: polygon.map((p) => ({ x: p.x / scale, y: p.y / scale })) });
      }
      return;
    }

    if (tool === 'freehand') {
      interaction.current = { mode: 'freehand', points: [point] };
      setVersion((v) => v + 1);
      return;
    }

    if (tool === 'polygon') {
      if (draftPolygon.length >= 3) {
        const first = draftPolygon[0];
        if (Math.hypot(first.x - point.x, first.y - point.y) < 10 / zoom) {
          closePolygon(draftPolygon);
          return;
        }
      }
      setDraftPolygon((points) => [...points, point]);
      return;
    }

    if (tool === 'keypoint') {
      const skeletonLength = activeClass?.keypoints?.length ?? 0;
      const next = [...draftKeypoints, point];
      if (skeletonLength <= 1 || next.length >= skeletonLength) {
        onCreate({ kind: 'keypoints', points: next });
        setDraftKeypoints([]);
      } else {
        setDraftKeypoints(next);
      }
      return;
    }

    if (tool === 'box') {
      interaction.current = { mode: 'draw-box', start: point, current: point };
      setVersion((v) => v + 1);
      return;
    }

    // Select tool.
    const handle = handleHit(point);
    if (handle) {
      const annotation = annotations.find((item) => item.id === handle.id)!;
      onBeginEdit();
      interaction.current = {
        mode: 'resize',
        id: annotation.id,
        handle: handle.handle,
        original: annotation.geometry,
        start: point,
      };
      return;
    }
    const hit = hitTest(point);
    if (hit) {
      onSelect(hit.annotation.id);
      if (hit.vertex !== undefined) {
        onBeginEdit();
        interaction.current = {
          mode: 'vertex',
          id: hit.annotation.id,
          index: hit.vertex,
          original: hit.annotation.geometry,
        };
      } else {
        if (hit.annotation.geometry.kind === 'polygon' && event.altKey) {
          const points = hit.annotation.geometry.points.filter((_, index) => index !== hit.vertex);
          if (points.length >= 3) onUpdate(hit.annotation.id, { kind: 'polygon', points }, true);
          return;
        }
        onBeginEdit();
        interaction.current = {
          mode: 'move',
          id: hit.annotation.id,
          start: point,
          original: hit.annotation.geometry,
        };
      }
      return;
    }
    onSelect(null);
    interaction.current = { mode: 'pan', start: screenPoint, pan0: pan };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const point = toImage(screenPoint.x, screenPoint.y);
    if (tool === 'polygon' || draftPolygon.length > 0) setCursor(point);

    const active = interaction.current;
    switch (active.mode) {
      case 'pan': {
        const dx = screenPoint.x - active.start.x;
        const dy = screenPoint.y - active.start.y;
        onTransform(zoom, { x: active.pan0.x + dx, y: active.pan0.y + dy });
        break;
      }
      case 'draw-box': {
        active.current = point;
        setVersion((v) => v + 1);
        break;
      }
      case 'move': {
        const dx = point.x - active.start.x;
        const dy = point.y - active.start.y;
        onUpdate(active.id, translateGeometry(active.original, dx, dy), false);
        break;
      }
      case 'resize': {
        if (active.original.kind !== 'bbox') break;
        onUpdate(active.id, resizeBox(active.original, active.handle, point), false);
        break;
      }
      case 'vertex': {
        const geometry = active.original;
        if (geometry.kind === 'keypoints' || geometry.kind === 'polygon' || geometry.kind === 'polyline') {
          const points = geometry.points.map((p, index) => (index === active.index ? point : p));
          onUpdate(active.id, { ...geometry, points }, false);
        }
        break;
      }
      case 'freehand': {
        active.points.push(point);
        setVersion((v) => v + 1);
        break;
      }
      default:
        break;
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    canvas?.releasePointerCapture(event.pointerId);
    const active = interaction.current;
    if (active.mode === 'draw-box') {
      const rect = {
        x: Math.min(active.start.x, active.current.x),
        y: Math.min(active.start.y, active.current.y),
        width: Math.abs(active.current.x - active.start.x),
        height: Math.abs(active.current.y - active.start.y),
      };
      if (rect.width > 2 && rect.height > 2) {
        onCreate({ kind: 'bbox', ...rect });
      }
    }
    if (active.mode === 'freehand') {
      const simplified = simplifyPolygon(active.points, 2);
      if (simplified.length >= 3 && polygonArea(simplified) > 8) {
        onCreate({ kind: 'polygon', points: simplified });
      }
    }
    if (active.mode === 'move' || active.mode === 'resize' || active.mode === 'vertex') {
      const annotation = annotations.find((item) => item.id === active.id);
      if (annotation) onUpdate(active.id, annotation.geometry, true);
    }
    interaction.current = { mode: 'idle' };
  };

  const onDoubleClick = () => {
    if (draftPolygon.length >= 3) closePolygon(draftPolygon);
  };

  /* -------------------------------------------------------------- keyboard */

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === ' ') {
      spaceDown.current = true;
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const nudge = (dx: number, dy: number) => {
      if (!selectedId) return;
      const annotation = annotations.find((item) => item.id === selectedId);
      if (!annotation) return;
      event.preventDefault();
      onBeginEdit();
      onUpdate(selectedId, translateGeometry(annotation.geometry, dx, dy), true);
    };

    if (keyboardPlacement) {
      if (event.key === 'ArrowLeft') keyboardPlacement.current.x = Math.max(0, keyboardPlacement.current.x - step);
      else if (event.key === 'ArrowRight') keyboardPlacement.current.x = Math.min(image.width, keyboardPlacement.current.x + step);
      else if (event.key === 'ArrowUp') keyboardPlacement.current.y = Math.max(0, keyboardPlacement.current.y - step);
      else if (event.key === 'ArrowDown') keyboardPlacement.current.y = Math.min(image.height, keyboardPlacement.current.y + step);
      else if (event.key === 'Enter') {
        event.preventDefault();
        if (!keyboardPlacement.startFixed) {
          setKeyboardPlacement({ ...keyboardPlacement, startFixed: true });
          return;
        }
        const rect = {
          x: Math.min(keyboardPlacement.start.x, keyboardPlacement.current.x),
          y: Math.min(keyboardPlacement.start.y, keyboardPlacement.current.y),
          width: Math.abs(keyboardPlacement.current.x - keyboardPlacement.start.x),
          height: Math.abs(keyboardPlacement.current.y - keyboardPlacement.start.y),
        };
        if (rect.width > 2 && rect.height > 2) onCreate({ kind: 'bbox', ...rect });
        setKeyboardPlacement(null);
        return;
      } else if (event.key === 'Escape') {
        setKeyboardPlacement(null);
        return;
      } else {
        return;
      }
      event.preventDefault();
      setVersion((v) => v + 1);
      return;
    }

    switch (event.key) {
      case 'ArrowLeft':
        nudge(-step, 0);
        break;
      case 'ArrowRight':
        nudge(step, 0);
        break;
      case 'ArrowUp':
        nudge(0, -step);
        break;
      case 'ArrowDown':
        nudge(0, step);
        break;
      case 'Enter':
        if (draftPolygon.length >= 3) {
          event.preventDefault();
          closePolygon(draftPolygon);
        } else if (selectedId) {
          event.preventDefault();
          setDraftPolygon([]);
        } else if (tool === 'box' || tool === 'select') {
          event.preventDefault();
          const center = { x: image.width / 2, y: image.height / 2 };
          setKeyboardPlacement({ start: center, current: center, startFixed: false });
        }
        break;
      case 'Escape':
        setDraftPolygon([]);
        setDraftKeypoints([]);
        setKeyboardPlacement(null);
        onSelect(null);
        break;
      case 'Delete':
      case 'Backspace':
        if (selectedId) {
          event.preventDefault();
          onDeleteSelected();
        }
        break;
      default:
        break;
    }
  };

  const onKeyUp = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === ' ') spaceDown.current = false;
  };

  const cursorStyle =
    tool === 'pan'
      ? 'grab'
      : tool === 'select'
        ? 'default'
        : tool === 'wand'
          ? 'copy'
          : 'crosshair';

  return (
    <div ref={containerRef} className="checkerboard relative h-full w-full overflow-hidden bg-[var(--canvas-bg)]">
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        aria-label={t('studio.canvasLabel', { name: image.name })}
        aria-describedby="canvas-instructions"
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter Escape Delete"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={(event) => event.preventDefault()}
        className="canvas-surface absolute inset-0 size-full touch-none outline-none"
        style={{ width: size.width, height: size.height, cursor: cursorStyle }}
      />
      <p id="canvas-instructions" className="sr-only">
        {t('studio.canvasHelp')}
      </p>
      {keyboardPlacement ? (
        <div
          role="status"
          className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs shadow"
        >
          {t('studio.keyboardPlacement')}
        </div>
      ) : null}
      {draftPolygon.length > 0 ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs shadow">
          Enter or double-click to close · Esc to cancel
        </div>
      ) : null}
    </div>
  );
}

type ChipTranslate = (key: 'autolabel.confidence', vars?: Record<string, string | number>) => string;

function labelFor(
  annotation: Annotation,
  cls: ClassDef | undefined,
  showConfidence: boolean,
  t: ChipTranslate,
): string {
  const name = cls?.name ?? 'Unknown';
  if (showConfidence && annotation.confidence !== undefined) {
    return `${name} ${Math.round(annotation.confidence * 100)}%`;
  }
  void t;
  return name;
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  const width = ctx.measureText(text).width + 10;
  const height = 16;
  const top = Math.max(0, y - height);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, top, width, height, 3);
  ctx.fill();
  ctx.fillStyle = '#0b0d12';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 5, top + height / 2 + 0.5);
  ctx.restore();
}

function drawHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  const points = [
    [x, y],
    [x + width / 2, y],
    [x + width, y],
    [x + width, y + height / 2],
    [x + width, y + height],
    [x + width / 2, y + height],
    [x, y + height],
    [x, y + height / 2],
  ];
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const [px, py] of points) {
    ctx.beginPath();
    ctx.rect(px - 4, py - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

