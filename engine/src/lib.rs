//! OpenLabel feature engine.
//!
//! This crate implements the pixel-bound half of the few-shot detector: the
//! per-cell statistics pass and the descriptor computation. It is compiled to
//! WebAssembly with a small hand-written C ABI, so the browser loads it without
//! a binding generator and the whole module stays a few tens of kilobytes.
//!
//! The formulas intentionally mirror `src/autolabel/features.ts`; that file
//! remains the reference implementation and the JavaScript fallback. Any change
//! here must keep `tests/unit/engine-parity.test.ts` green.

#![allow(clippy::missing_safety_doc)]

use std::alloc::{alloc, dealloc, Layout};

pub const ORIENT_BINS: usize = 8;
pub const CELL_PLANES: usize = 3 + ORIENT_BINS + 1;
pub const SUB: usize = 4;
pub const DESCRIPTOR_DIM: usize = SUB * SUB * CELL_PLANES + 2;
pub const MAX_PLANES: usize = CELL_PLANES;

const VERSION: u32 = 1;

pub struct Grid {
    gw: usize,
    gh: usize,
    cell: usize,
    width: usize,
    height: usize,
    planes: Vec<f32>,
    integral: Vec<f32>,
}

/// One slot per live grid. The pipeline keeps at most one image's levels alive,
/// but two handles are required because a level is described after the coarser
/// level has been built.
static mut GRIDS: Vec<Option<Grid>> = Vec::new();

/// Scratch buffer handed to JavaScript for pixel uploads. Reused so repeated
/// images do not allocate inside the module.
static mut SCRATCH: Option<Vec<u8>> = None;

#[no_mangle]
pub extern "C" fn ol_version() -> u32 {
    VERSION
}

/// Reserves `len` bytes of scratch memory and returns a pointer to it. The
/// buffer is owned by the module and stays valid until the next call.
#[no_mangle]
pub extern "C" fn ol_scratch(len: usize) -> *mut u8 {
    unsafe {
        let buffer = &mut *std::ptr::addr_of_mut!(SCRATCH);
        match buffer {
            Some(existing) if existing.len() >= len => existing.as_mut_ptr(),
            _ => {
                *buffer = Some(vec![0u8; len]);
                buffer.as_mut().unwrap().as_mut_ptr()
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn ol_alloc(len: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align(len.max(4), 4).unwrap()) }
}

#[no_mangle]
pub unsafe extern "C" fn ol_dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        dealloc(ptr, Layout::from_size_align(len.max(4), 4).unwrap());
    }
}

/// tan(k * PI / 8) boundaries; comparing ratios avoids atan2, which has no
/// WebAssembly instruction and dominates the pixel pass otherwise.
const TAN_1: f64 = 0.41421356237309503;
const TAN_2: f64 = 1.0;
const TAN_3: f64 = 2.414213562373095;

fn orientation_bin(gx: f64, gy: f64) -> usize {
    if gx == 0.0 {
        return 4;
    }
    let (dx, dy) = if gx < 0.0 { (-gx, -gy) } else { (gx, gy) };
    let ratio = dy / dx;
    if ratio < -TAN_3 {
        4
    } else if ratio < -TAN_2 {
        5
    } else if ratio < -TAN_1 {
        6
    } else if ratio < 0.0 {
        7
    } else if ratio < TAN_1 {
        0
    } else if ratio < TAN_2 {
        1
    } else if ratio < TAN_3 {
        2
    } else {
        3
    }
}

fn cell_bounds(rect: &[f32; 4], grid: &Grid) -> Option<(usize, usize, usize, usize)> {
    let clamp = |value: f32, max: usize| -> usize {
        let v = value as f64;
        if v.is_nan() || v <= 0.0 {
            0
        } else if v >= max as f64 {
            max
        } else {
            v as usize
        }
    };
    let x0 = clamp((rect[0] / grid.cell as f32).floor(), grid.gw);
    let y0 = clamp((rect[1] / grid.cell as f32).floor(), grid.gh);
    let x1 = clamp(((rect[0] + rect[2]) / grid.cell as f32).ceil(), grid.gw);
    let y1 = clamp(((rect[1] + rect[3]) / grid.cell as f32).ceil(), grid.gh);
    if x1 <= x0 || y1 <= y0 {
        None
    } else {
        Some((x0, y0, x1, y1))
    }
}

/// Unchecked summed-area lookup; the caller clamps every coordinate into the
/// table, so the index arithmetic cannot leave the allocation.
unsafe fn integral_rect(base: *const f32, stride: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> f64 {
    let a = y0 * stride;
    let b = y1 * stride;
    *base.add(b + x1) as f64 - *base.add(a + x1) as f64 - *base.add(b + x0) as f64
        + *base.add(a + x0) as f64
}

fn build_integral(plane: &[f32], gw: usize, gh: usize) -> Vec<f32> {
    let mut out = vec![0f32; (gw + 1) * (gh + 1)];
    for y in 0..gh {
        // The reference accumulates in f64 and stores f32, so mirror that order
        // exactly; otherwise the integrals drift by a few float32 ulps.
        let mut row_sum = 0f64;
        for x in 0..gw {
            row_sum += plane[y * gw + x] as f64;
            out[(y + 1) * (gw + 1) + (x + 1)] =
                (out[y * (gw + 1) + (x + 1)] as f64 + row_sum) as f32;
        }
    }
    out
}

/// Builds the cell grid for an RGBA image already staged with `ol_scratch`.
///
/// # Safety
/// `ptr` must address at least `width * height * 4` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn ol_grid_build(ptr: *const u8, width: usize, height: usize, cell: usize) -> i32 {
    if ptr.is_null() || width == 0 || height == 0 || cell == 0 {
        return -1;
    }
    let cell = cell.max(1);
    let gw = width.div_ceil(cell).max(1);
    let gh = height.div_ceil(cell).max(1);
    let count = gw * gh;
    if count > (1 << 26) {
        return -2;
    }

    let mut lum = vec![0f32; width * height];
    let mut planes = vec![0f32; CELL_PLANES * count];
    let mut counts = vec![0f32; count];

    // Every index below is clamped by construction, so the pixel pass uses raw
    // pointers: wasm bounds checks were the dominant cost before this.
    unsafe {
        let lum_ptr = lum.as_mut_ptr();
        for index in 0..width * height {
            let pixel = ptr.add(index * 4);
            *lum_ptr.add(index) =
                0.299 * *pixel as f32 + 0.587 * *pixel.add(1) as f32 + 0.114 * *pixel.add(2) as f32;
        }

        let planes_ptr = planes.as_mut_ptr();
        let counts_ptr = counts.as_mut_ptr();
        for y in 0..height {
            let cell_y = y / cell;
            let row = y * width;
            let yp = if y < height - 1 { y + 1 } else { y };
            let ym = if y > 0 { y - 1 } else { y };
            for x in 0..width {
                let index = row + x;
                let pixel = ptr.add(index * 4);
                let cell_index = cell_y * gw + x / cell;
                let r = *pixel as f32;
                let g = *pixel.add(1) as f32;
                let b = *pixel.add(2) as f32;

                *planes_ptr.add(cell_index) += 0.299 * r + 0.587 * g + 0.114 * b;
                *planes_ptr.add(count + cell_index) += r - g;
                *planes_ptr.add(2 * count + cell_index) += 0.5 * (r + g) - b;
                *counts_ptr.add(cell_index) += 1.0;

                let xm = if x > 0 { x - 1 } else { x };
                let xp = if x < width - 1 { x + 1 } else { x };
                let gx = ((*lum_ptr.add(row + xp) - *lum_ptr.add(row + xm)) * 0.5) as f64;
                let gy = ((*lum_ptr.add(yp * width + x) - *lum_ptr.add(ym * width + x)) * 0.5) as f64;
                let mag = (gx * gx + gy * gy).sqrt();
                let bin = orientation_bin(gx, gy);

                *planes_ptr.add((3 + bin) * count + cell_index) += mag as f32;
                *planes_ptr.add((3 + ORIENT_BINS) * count + cell_index) += mag as f32;
            }
        }
    }

    for index in 0..count {
        let divisor = if counts[index] == 0.0 { 1.0 } else { counts[index] };
        for plane in 0..CELL_PLANES {
            planes[plane * count + index] /= divisor;
        }
    }

    let mut integral = Vec::with_capacity(CELL_PLANES * (gw + 1) * (gh + 1));
    for plane in 0..CELL_PLANES {
        integral.extend(build_integral(&planes[plane * count..(plane + 1) * count], gw, gh));
    }

    let grid = Grid {
        gw,
        gh,
        cell,
        width,
        height,
        planes,
        integral,
    };
    unsafe {
        let slots = &mut *std::ptr::addr_of_mut!(GRIDS);
        let handle = match slots.iter().position(|slot| slot.is_none()) {
            Some(index) => {
                slots[index] = Some(grid);
                index
            }
            None => {
                slots.push(Some(grid));
                slots.len() - 1
            }
        };
        handle as i32
    }
}

#[no_mangle]
pub extern "C" fn ol_grid_release(handle: usize) {
    unsafe {
        let slots = &mut *std::ptr::addr_of_mut!(GRIDS);
        if let Some(slot) = slots.get_mut(handle) {
            *slot = None;
        }
    }
}

unsafe fn grid_at(handle: usize) -> Option<&'static Grid> {
    let slots = &*std::ptr::addr_of!(GRIDS);
    slots.get(handle).and_then(|slot| slot.as_ref())
}

#[no_mangle]
pub extern "C" fn ol_grid_gw(handle: usize) -> usize {
    unsafe { grid_at(handle).map(|grid| grid.gw).unwrap_or(0) }
}

#[no_mangle]
pub extern "C" fn ol_grid_gh(handle: usize) -> usize {
    unsafe { grid_at(handle).map(|grid| grid.gh).unwrap_or(0) }
}

#[no_mangle]
pub extern "C" fn ol_plane_ptr(handle: usize, plane: usize) -> *const f32 {
    if plane >= MAX_PLANES {
        return std::ptr::null();
    }
    unsafe {
        match grid_at(handle) {
            Some(grid) => grid.planes[plane * grid.gw * grid.gh..].as_ptr(),
            None => std::ptr::null(),
        }
    }
}

#[no_mangle]
pub extern "C" fn ol_integral_ptr(handle: usize, plane: usize) -> *const f32 {
    if plane >= MAX_PLANES {
        return std::ptr::null();
    }
    unsafe {
        match grid_at(handle) {
            Some(grid) => {
                let stride = (grid.gw + 1) * (grid.gh + 1);
                grid.integral[plane * stride..].as_ptr()
            }
            None => std::ptr::null(),
        }
    }
}

fn descriptor_into(grid: &Grid, rect: &[f32; 4], out: &mut [f32; DESCRIPTOR_DIM]) -> bool {
    let Some((x0, y0, x1, y1)) = cell_bounds(rect, grid) else {
        return false;
    };
    for value in out.iter_mut() {
        *value = 0.0;
    }
    let span_x = (x1 - x0) as f64;
    let span_y = (y1 - y0) as f64;
    let row_stride = grid.gw + 1;
    let plane_size = (grid.gw + 1) * (grid.gh + 1);
    let integral = grid.integral.as_ptr();

    for sy in 0..SUB {
        let ry0 = y0 as f64 + span_y * sy as f64 / SUB as f64;
        let ry1 = if sy == SUB - 1 {
            y1 as f64
        } else {
            y0 as f64 + span_y * (sy + 1) as f64 / SUB as f64
        };
        let iy0 = (ry0.floor() as usize).clamp(y0, y1);
        let iy1 = ((iy0 + 1).max(ry1.ceil() as usize)).clamp(y0, y1);
        for sx in 0..SUB {
            let rx0 = x0 as f64 + span_x * sx as f64 / SUB as f64;
            let rx1 = if sx == SUB - 1 {
                x1 as f64
            } else {
                x0 as f64 + span_x * (sx + 1) as f64 / SUB as f64
            };
            let ix0 = (rx0.floor() as usize).clamp(x0, x1);
            let ix1 = ((ix0 + 1).max(rx1.ceil() as usize)).clamp(x0, x1);
            let area = (((ix1 - ix0) * (iy1 - iy0)) as f64).max(1.0);
            let base = (sy * SUB + sx) * CELL_PLANES;

            let plane = |index: usize| -> f64 {
                // SAFETY: indexes are clamped cell coordinates inside the table.
                unsafe { integral_rect(integral.add(index * plane_size), row_stride, ix0, iy0, ix1, iy1) }
            };

            out[base] = (plane(0) / area / 255.0 - 0.5) as f32;
            out[base + 1] = (plane(1) / area / 510.0) as f32;
            out[base + 2] = (plane(2) / area / 510.0) as f32;

            let mut hist_sum = 0f64;
            for bin in 0..ORIENT_BINS {
                let value = plane(3 + bin) / area / 255.0;
                out[base + 3 + bin] = value as f32;
                hist_sum += out[base + 3 + bin] as f64;
            }
            let inv = if hist_sum > 1e-6 { 1.0 / hist_sum } else { 0.0 };
            for bin in 0..ORIENT_BINS {
                out[base + 3 + bin] = (out[base + 3 + bin] as f64 * inv) as f32;
            }
            let mag = plane(3 + ORIENT_BINS) / area / 255.0;
            out[base + 3 + ORIENT_BINS] = (mag * 8.0).ln_1p() as f32;
        }
    }

    let aspect = (rect[2].max(1e-3) / rect[3].max(1e-3)).ln();
    let relative = (((rect[2] as f64 * rect[3] as f64) / (grid.width as f64 * grid.height as f64))
        .max(1e-6))
    .ln();
    out[DESCRIPTOR_DIM - 2] = (aspect / 4.0) as f32;
    out[DESCRIPTOR_DIM - 1] = (relative / 8.0) as f32;

    let mut norm = 0f64;
    for value in out.iter() {
        norm += (*value as f64) * (*value as f64);
    }
    let norm = if norm > 0.0 { norm.sqrt() } else { 1.0 };
    for value in out.iter_mut() {
        *value = (*value as f64 / norm) as f32;
    }
    true
}

/// Writes one descriptor for each `[x, y, width, height]` quadruple.
///
/// Returns the number of descriptors written; a degenerate rectangle writes
/// zeros and is still counted, so the caller can keep its proposal indices.
#[no_mangle]
pub unsafe extern "C" fn ol_descriptors(
    handle: usize,
    rects: *const f32,
    count: usize,
    out: *mut f32,
) -> usize {
    if rects.is_null() || out.is_null() {
        return 0;
    }
    let grid = match grid_at(handle) {
        Some(grid) => grid,
        None => return 0,
    };
    let input = std::slice::from_raw_parts(rects, count * 4);
    let output = std::slice::from_raw_parts_mut(out, count * DESCRIPTOR_DIM);
    for index in 0..count {
        let rect = [
            input[index * 4],
            input[index * 4 + 1],
            input[index * 4 + 2],
            input[index * 4 + 3],
        ];
        let slot: &mut [f32; DESCRIPTOR_DIM] = (&mut output[index * DESCRIPTOR_DIM..(index + 1) * DESCRIPTOR_DIM])
            .try_into()
            .unwrap();
        let ok = descriptor_into(grid, &rect, slot);
        if !ok {
            for value in slot.iter_mut() {
                *value = 0.0;
            }
        }
    }
    count
}