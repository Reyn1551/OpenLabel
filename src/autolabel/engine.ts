import type { CellGrid, Rect, RGBAImage } from './features';
import { CELL_PLANES } from './features';

/**
 * WebAssembly backend for the pixel-bound feature pass.
 *
 * The module is built from `engine/` (Rust, hand-written C ABI, no bindings) and
 * shipped next to the app. It computes the same numbers as `features.ts`; that
 * file stays the reference implementation and the fallback for engines without
 * WebAssembly.
 *
 * Memory contract: `buildCellGrid` returns typed-array views into the module's
 * linear memory. They stay valid until the next grid build (which may grow the
 * memory), so callers must not hold them across images.
 */

export const DESCRIPTOR_DIM = 4 * 4 * CELL_PLANES + 2;

interface EngineExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  ol_version(): number;
  ol_scratch(len: number): number;
  ol_grid_build(ptr: number, width: number, height: number, cell: number): number;
  ol_grid_release(handle: number): void;
  ol_grid_gw(handle: number): number;
  ol_grid_gh(handle: number): number;
  ol_plane_ptr(handle: number, plane: number): number;
  ol_integral_ptr(handle: number, plane: number): number;
  ol_descriptors(handle: number, rects: number, count: number, out: number): number;
}

export interface WasmEngine {
  version: number;
  buildCellGrid(image: RGBAImage, cell: number): CellGrid;
  descriptor(grid: CellGrid, rect: Rect): Float32Array | null;
  descriptors(grid: CellGrid, rects: Rect[]): Float32Array[];
  release(grid: CellGrid): void;
}

export function isWasmGrid(grid: CellGrid): boolean {
  return grid.engine === 'wasm';
}

/** Instantiates the module from bytes or a response; the caller owns fetching. */
export async function instantiateEngine(source: BufferSource | Response): Promise<WasmEngine> {
  const instance =
    source instanceof Response
      ? (await WebAssembly.instantiateStreaming(source, {})).instance
      : (await WebAssembly.instantiate(source, {})).instance;
  const exports = instance.exports as EngineExports;
  if (typeof exports.ol_descriptors !== 'function' || !(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error('engine.wasm does not expose the expected OpenLabel ABI');
  }

  const version = exports.ol_version();
  const cellPlanes = CELL_PLANES;

  /**
   * Stages rectangles and descriptors in one scratch region.
   *
   * `ol_scratch` may reallocate, which invalidates every earlier view into
   * linear memory, so the region is requested once per call and the views are
   * re-created afterwards.
   */
  const describe = (grid: CellGrid, rects: Rect[], count: number): Float32Array => {
    const rectBytes = count * 16;
    const outBytes = count * DESCRIPTOR_DIM * 4;
    const base = exports.ol_scratch(rectBytes + outBytes);
    const rectsView = new Float32Array(exports.memory.buffer, base, count * 4);
    for (let index = 0; index < count; index += 1) {
      const rect = rects[index];
      rectsView[index * 4] = rect.x;
      rectsView[index * 4 + 1] = rect.y;
      rectsView[index * 4 + 2] = rect.width;
      rectsView[index * 4 + 3] = rect.height;
    }
    const outPtr = base + rectBytes;
    const written = exports.ol_descriptors(handleOf(grid), base, count, outPtr);
    if (written !== count) throw new Error(`engine.wasm described ${written} of ${count} rectangles`);
    return new Float32Array(exports.memory.buffer, outPtr, count * DESCRIPTOR_DIM).slice();
  };

  return {
    version,
    buildCellGrid(image: RGBAImage, cell: number): CellGrid {
      const pixels = image.width * image.height * 4;
      const ptr = exports.ol_scratch(pixels);
      new Uint8Array(exports.memory.buffer, ptr, pixels).set(image.data.subarray(0, pixels));
      const handle = exports.ol_grid_build(ptr, image.width, image.height, cell);
      if (handle < 0) throw new Error(`engine.wasm rejected the image (status ${handle})`);

      const gw = exports.ol_grid_gw(handle);
      const gh = exports.ol_grid_gh(handle);
      const cells = gw * gh;
      const stride = (gw + 1) * (gh + 1);
      const planes: Float32Array[] = [];
      const integral: Float32Array[] = [];
      for (let plane = 0; plane < cellPlanes; plane += 1) {
        planes.push(new Float32Array(exports.memory.buffer, exports.ol_plane_ptr(handle, plane), cells));
        integral.push(new Float32Array(exports.memory.buffer, exports.ol_integral_ptr(handle, plane), stride));
      }
      return {
        gw,
        gh,
        cell,
        width: image.width,
        height: image.height,
        planes,
        integral,
        engine: 'wasm',
        handle,
      };
    },

    descriptor(grid: CellGrid, rect: Rect): Float32Array | null {
      if (!isWasmGrid(grid)) throw new Error('engine.wasm needs a grid built by engine.wasm');
      const values = describe(grid, [rect], 1);
      // A degenerate rectangle is written as zeros; a real descriptor is
      // L2-normalized, so it can never be the zero vector.
      for (let index = 0; index < DESCRIPTOR_DIM; index += 1) {
        if (values[index] !== 0) return values;
      }
      return null;
    },

    descriptors(grid: CellGrid, rects: Rect[]): Float32Array[] {
      if (!isWasmGrid(grid)) throw new Error('engine.wasm needs a grid built by engine.wasm');
      if (rects.length === 0) return [];
      const flat = describe(grid, rects, rects.length);
      const out: Float32Array[] = [];
      for (let index = 0; index < rects.length; index += 1) {
        out.push(flat.subarray(index * DESCRIPTOR_DIM, (index + 1) * DESCRIPTOR_DIM));
      }
      return out;
    },

    release(grid: CellGrid): void {
      if (isWasmGrid(grid)) exports.ol_grid_release(handleOf(grid));
    },
  };
}

function handleOf(grid: CellGrid): number {
  if (grid.handle === undefined) throw new Error('grid has no engine handle');
  return grid.handle;
}