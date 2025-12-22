// exr_min_rgba32f.js
// Pure JS minimal OpenEXR encoder (single-part scanline, RGBA FLOAT32)
// compression: NONE / ZIPS / ZIP
//
// Depends: ByteWriter.js (must provide: i32,u8,u64,cstr,bytes,finish,size)

import { ByteWriter } from "./ByteWriter.js";
import { deflate } from "https://taisukef.github.io/zlib.js/es/deflate.js";

const textEncoder = new TextEncoder();

/**
 * Encode OpenEXR (single-part scanline, RGBA FLOAT32)
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} rgbaInterleaved - length = width*height*4 (R,G,B,A)
 * @param {object} [opts]
 * @param {"NONE"|"ZIPS"|"ZIP"} [opts.compression="NONE"]
 * @returns {Uint8Array} .exr bytes
 */
export function encodeEXR_RGBA32F(width, height, rgbaInterleaved, opts = {}) {
  const { compression = "ZIP" } = opts;

  if (!(rgbaInterleaved instanceof Float32Array)) throw new TypeError("rgbaInterleaved must be Float32Array");
  if (rgbaInterleaved.length !== width * height * 4) throw new RangeError("size mismatch");

  // OpenEXR compression enum (scanline): NONE=0, ZIPS=2, ZIP=3
  const compId =
    compression === "NONE" ? 0 :
    compression === "ZIPS" ? 2 :
    compression === "ZIP"  ? 3 :
    (() => { throw new Error("unknown compression"); })();

  const blockLines = (compression === "ZIP") ? 16 : 1; // ZIP=16 lines, ZIPS=1 line

  // ---- Build header bytes first (so we can compute offsets cleanly) ----
  const headerWriter = buildHeader(width, height, compId);
  const headerBytes = headerWriter.finish();
  const headerEndPos = headerBytes.byteLength;

  // ---- Offset table size: one offset per block ----
  const numBlocks = Math.ceil(height / blockLines);
  const offsetTableBytes = numBlocks * 8;

  // ---- Generate blocks (chunks) ----
  // Uncompressed scanline bytes (A,B,G,R planar float32)
  const bytesPerSample = 4;
  const scanlineDataBytes = width * 4 * bytesPerSample; // 4ch * float32
  const maxUncompressedBlockBytes = scanlineDataBytes * blockLines;

  const blocks = new Array(numBlocks);
  const offsets = new BigUint64Array(numBlocks);

  for (let bi = 0; bi < numBlocks; bi++) {
    const y0 = bi * blockLines;
    const lines = Math.min(blockLines, height - y0);

    // Build uncompressed payload for this block (concatenate scanlines)
    const uncompressed = new Uint8Array(scanlineDataBytes * lines);
    let dst = 0;

    for (let ly = 0; ly < lines; ly++) {
      const y = y0 + ly;

      // planar arrays for this scanline
      const lineA = new Float32Array(width);
      const lineB = new Float32Array(width);
      const lineG = new Float32Array(width);
      const lineR = new Float32Array(width);

      const rowBase = y * width * 4;
      for (let x = 0; x < width; x++) {
        const i = rowBase + x * 4;
        lineR[x] = rgbaInterleaved[i + 0];
        lineG[x] = rgbaInterleaved[i + 1];
        lineB[x] = rgbaInterleaved[i + 2];
        lineA[x] = rgbaInterleaved[i + 3];
      }

      // A,B,G,R contiguous
      uncompressed.set(new Uint8Array(lineA.buffer), dst); dst += width * 4;
      uncompressed.set(new Uint8Array(lineB.buffer), dst); dst += width * 4;
      uncompressed.set(new Uint8Array(lineG.buffer), dst); dst += width * 4;
      uncompressed.set(new Uint8Array(lineR.buffer), dst); dst += width * 4;
    }

    let payload = uncompressed;

    if (compId === 2 || compId === 3) {
      // ZIP/ZIPS transform: reorder -> predictor -> deflate
      const compressed = exrZipCompress(uncompressed, deflate);

      // Important: if compression isn't smaller, store uncompressed payload instead
      if (compressed.byteLength < uncompressed.byteLength) {
        payload = compressed;
      }
    } else {
      // NONE: payload is uncompressed, and MUST match expected bytes
      if (uncompressed.byteLength > maxUncompressedBlockBytes) {
        throw new Error("internal: uncompressed block too large");
      }
    }

    // chunk = y(int32) + dataSize(int32) + payload
    const bw = new ByteWriter();
    bw.i32(y0);
    bw.i32(payload.byteLength);
    bw.bytes(payload);
    blocks[bi] = bw.finish();
  }

  // ---- Compute offsets ----
  let runningOffset = BigInt(headerEndPos + offsetTableBytes);
  for (let i = 0; i < numBlocks; i++) {
    offsets[i] = runningOffset;
    runningOffset += BigInt(blocks[i].byteLength);
  }

  // ---- Assemble final file ----
  const out = new ByteWriter();
  out.bytes(headerBytes);

  // offsets (u64 LE)
  for (let i = 0; i < numBlocks; i++) out.u64(offsets[i]);

  // blocks
  for (const b of blocks) out.bytes(b);

  return out.finish();
}

/**
 * Back-compat name (your original function name) — defaults to NONE
 */
export function encodeEXRUncompressedRGBA32F(width, height, rgbaInterleaved) {
  return encodeEXR_RGBA32F(width, height, rgbaInterleaved, { compression: "NONE" });
}

// ---------- Header builder ----------
function buildHeader(width, height, compId) {
  const w = new ByteWriter();

  // Magic number = 20000630 (int32 LE)
  w.i32(20000630);

  // Version field (int32): version=2 + long names bit (0x400)
  w.i32(2 | 0x400);

  // Required attributes
  writeAttribute(w, "channels", "chlist", makeChListRGBA_FLOAT());
  writeAttribute(w, "compression", "compression", makeU8(compId));

  const box = makeBox2i(0, 0, width - 1, height - 1);
  writeAttribute(w, "dataWindow", "box2i", box);
  writeAttribute(w, "displayWindow", "box2i", box);

  writeAttribute(w, "lineOrder", "lineOrder", makeU8(0));          // INCREASING_Y
  writeAttribute(w, "pixelAspectRatio", "float", makeF32(1.0));
  writeAttribute(w, "screenWindowCenter", "v2f", makeV2f(0.0, 0.0));
  writeAttribute(w, "screenWindowWidth", "float", makeF32(1.0));

  // end of header
  w.u8(0);
  return w;
}

// ---------- OpenEXR attribute helpers ----------
function writeAttribute(w, name, type, valueBytes) {
  w.cstr(name);
  w.cstr(type);
  w.i32(valueBytes.byteLength);
  w.bytes(valueBytes);
}

function makeBox2i(xMin, yMin, xMax, yMax) {
  const b = new ArrayBuffer(16);
  const dv = new DataView(b);
  dv.setInt32(0, xMin, true);
  dv.setInt32(4, yMin, true);
  dv.setInt32(8, xMax, true);
  dv.setInt32(12, yMax, true);
  return new Uint8Array(b);
}

function makeV2f(x, y) {
  const b = new ArrayBuffer(8);
  const dv = new DataView(b);
  dv.setFloat32(0, x, true);
  dv.setFloat32(4, y, true);
  return new Uint8Array(b);
}

function makeF32(v) {
  const b = new ArrayBuffer(4);
  new DataView(b).setFloat32(0, v, true);
  return new Uint8Array(b);
}

function makeU8(v) {
  return Uint8Array.of(v & 255);
}

// chlist: sequence of channels + terminating 0x00
function makeChListRGBA_FLOAT() {
  // Pixel data stores channels in alphabetical order by name.
  // For RGBA, that order is: A, B, G, R.
  const channels = ["A", "B", "G", "R"];
  const parts = [];
  let total = 0;

  for (const name of channels) {
    const nameBytes = textEncoder.encode(name);
    parts.push(nameBytes, Uint8Array.of(0)); total += nameBytes.byteLength + 1;

    // pixel type (int): FLOAT = 2
    const bType = new ArrayBuffer(4);
    new DataView(bType).setInt32(0, 2, true);
    parts.push(new Uint8Array(bType)); total += 4;

    // pLinear (u8): 0/1 (we set 1)
    parts.push(Uint8Array.of(1)); total += 1;

    // reserved (3 bytes)
    parts.push(Uint8Array.of(0, 0, 0)); total += 3;

    // xSampling (int), ySampling (int)
    const bS = new ArrayBuffer(8);
    const dvS = new DataView(bS);
    dvS.setInt32(0, 1, true);
    dvS.setInt32(4, 1, true);
    parts.push(new Uint8Array(bS)); total += 8;
  }

  parts.push(Uint8Array.of(0)); total += 1;

  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

// ---------- ZIP/ZIPS transform (reorder + predictor + zlib deflate) ----------
function exrZipCompress(uncompressedU8, deflate) {
  const reordered = exrZipReorder(uncompressedU8);
  const predicted = exrZipPredictor(reordered);
  return deflate(predicted);
}

function exrZipReorder(u8) {
  const n = u8.length;
  const out = new Uint8Array(n);
  let t1 = 0;
  let t2 = (n + 1) >> 1;
  for (let i = 0; i < n; i++) {
    out[(i & 1) ? t2++ : t1++] = u8[i];
  }
  return out;
}

function exrZipPredictor(u8) {
  const out = u8.slice();
  let p = out[0];
  for (let i = 1; i < out.length; i++) {
    const d = (out[i] - p + 128 + 256) & 255;
    p = out[i];
    out[i] = d;
  }
  return out;
}
