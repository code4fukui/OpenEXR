// Pure JS minimal OpenEXR encoder (single-part scanline, RGBA HALF)
// compression: NONE(0) / ZIPS(2) / ZIP(3)
//
// Input: Float32Array RGBA interleaved (R,G,B,A)
// Output: EXR bytes (Uint8Array) with channel order A,B,G,R planar

import { ByteWriter } from "./ByteWriter.js";
import { deflate } from "https://taisukef.github.io/zlib.js/es/deflate.js";

const textEncoder = new TextEncoder();

/**
 * Encode OpenEXR (single-part scanline, RGBA HALF/float16)
 * @param {number} width
 * @param {number} height
 * @param {Float16Array|Float32Array|Uint8Array} rgbaInterleaved - length = width*height*4 (R,G,B,A)
 * @param {object} [opts]
 * @param {"NONE"|"ZIPS"|"ZIP"} [opts.compression="NONE"]
 * @returns {Uint8Array}
 */
export function encodeEXR_RGBA16F(width, height, rgbaInterleaved, opts = {}) {
  const { compression = "ZIP" } = opts;
  if (rgbaInterleaved instanceof Uint8Array || rgbaInterleaved instanceof Uint8ClampedArray) {
    rgbaInterleaved = u8tof16(rgbaInterleaved);
  }
  console.log(rgbaInterleaved);
  if (!(rgbaInterleaved instanceof Float16Array || rgbaInterleaved instanceof Float32Array )) {
    throw new TypeError("rgbaInterleaved must be Float16Array or Float32Array");
  }
  if (rgbaInterleaved.length !== width * height * 4) throw new RangeError("size mismatch");
  
  // OpenEXR compression enum
  const compId =
    compression === "NONE" ? 0 :
    compression === "ZIPS" ? 2 :
    compression === "ZIP"  ? 3 :
    (() => { throw new Error("unknown compression"); })();

  const blockLines = (compression === "ZIP") ? 16 : 1; // ZIP=16, ZIPS=1

  // Header bytes
  const headerWriter = buildHeader_RGBA_HALF(width, height, compId);
  const headerBytes = headerWriter.finish();
  const headerEndPos = headerBytes.byteLength;

  const numBlocks = Math.ceil(height / blockLines);
  const offsetTableBytes = numBlocks * 8;

  // sizes
  const bytesPerSample = 2; // HALF
  const scanlineDataBytes = width * 4 * bytesPerSample; // 4ch
  const maxUncompressedBlockBytes = scanlineDataBytes * blockLines;

  const blocks = new Array(numBlocks);
  const offsets = new BigUint64Array(numBlocks);

  // work buffers (reuse to reduce GC)
  const lineA = new Uint16Array(width);
  const lineB = new Uint16Array(width);
  const lineG = new Uint16Array(width);
  const lineR = new Uint16Array(width);

  for (let bi = 0; bi < numBlocks; bi++) {
    const y0 = bi * blockLines;
    const lines = Math.min(blockLines, height - y0);

    const uncompressed = new Uint8Array(scanlineDataBytes * lines);
    let dst = 0;

    for (let ly = 0; ly < lines; ly++) {
      const y = y0 + ly;
      const rowBase = y * width * 4;

      for (let x = 0; x < width; x++) {
        const i = rowBase + x * 4;
        lineR[x] = f32ToF16Bits(rgbaInterleaved[i + 0]);
        lineG[x] = f32ToF16Bits(rgbaInterleaved[i + 1]);
        lineB[x] = f32ToF16Bits(rgbaInterleaved[i + 2]);
        lineA[x] = f32ToF16Bits(rgbaInterleaved[i + 3]);
      }

      // write A,B,G,R planar half bytes (little-endian)
      uncompressed.set(new Uint8Array(lineA.buffer), dst); dst += width * 2;
      uncompressed.set(new Uint8Array(lineB.buffer), dst); dst += width * 2;
      uncompressed.set(new Uint8Array(lineG.buffer), dst); dst += width * 2;
      uncompressed.set(new Uint8Array(lineR.buffer), dst); dst += width * 2;
    }

    let payload = uncompressed;

    if (compId === 2 || compId === 3) {
      const compressed = exrZipCompress(uncompressed, deflate);
      if (compressed.byteLength < uncompressed.byteLength) payload = compressed;
    } else {
      if (uncompressed.byteLength > maxUncompressedBlockBytes) {
        throw new Error("internal: uncompressed block too large");
      }
    }

    const bw = new ByteWriter();
    bw.i32(y0);
    bw.i32(payload.byteLength);
    bw.bytes(payload);
    blocks[bi] = bw.finish();
  }

  // offsets
  let runningOffset = BigInt(headerEndPos + offsetTableBytes);
  for (let i = 0; i < numBlocks; i++) {
    offsets[i] = runningOffset;
    runningOffset += BigInt(blocks[i].byteLength);
  }

  // final
  const out = new ByteWriter();
  out.bytes(headerBytes);
  for (let i = 0; i < numBlocks; i++) out.u64(offsets[i]);
  for (const b of blocks) out.bytes(b);
  return out.finish();
}

// ---------- Header (HALF) ----------
function buildHeader_RGBA_HALF(width, height, compId) {
  const w = new ByteWriter();

  w.i32(20000630);
  w.i32(2 | 0x400);

  writeAttribute(w, "channels", "chlist", makeChListRGBA_HALF());
  writeAttribute(w, "compression", "compression", makeU8(compId));

  const box = makeBox2i(0, 0, width - 1, height - 1);
  writeAttribute(w, "dataWindow", "box2i", box);
  writeAttribute(w, "displayWindow", "box2i", box);

  writeAttribute(w, "lineOrder", "lineOrder", makeU8(0));
  writeAttribute(w, "pixelAspectRatio", "float", makeF32(1.0));
  writeAttribute(w, "screenWindowCenter", "v2f", makeV2f(0.0, 0.0));
  writeAttribute(w, "screenWindowWidth", "float", makeF32(1.0));

  w.u8(0);
  return w;
}

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

// chlist for HALF: pixelType = 1
function makeChListRGBA_HALF() {
  const channels = ["A", "B", "G", "R"];
  const parts = [];
  let total = 0;

  for (const name of channels) {
    const nameBytes = textEncoder.encode(name);
    parts.push(nameBytes, Uint8Array.of(0)); total += nameBytes.byteLength + 1;

    // pixel type (int): HALF = 1
    const bType = new ArrayBuffer(4);
    new DataView(bType).setInt32(0, 1, true);
    parts.push(new Uint8Array(bType)); total += 4;

    parts.push(Uint8Array.of(1)); total += 1;          // pLinear
    parts.push(Uint8Array.of(0, 0, 0)); total += 3;     // reserved

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

// ---------- ZIP/ZIPS transform ----------
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

// ---------- float32 -> float16 bits ----------
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/**
 * Convert JS number (float32) to IEEE-754 half float bits (uint16).
 * Handles NaN/Inf/denormals reasonably.
 */
function f32ToF16Bits(x) {
  _f32[0] = x;
  const f = _u32[0];

  const sign = (f >>> 16) & 0x8000;
  const exp  = (f >>> 23) & 0xff;
  const mant = f & 0x7fffff;

  // NaN / Inf
  if (exp === 0xff) {
    if (mant === 0) return sign | 0x7c00;           // Inf
    return sign | 0x7c00 | (mant ? 0x0200 : 0);     // NaN (quiet)
  }

  // Convert exponent from bias 127 to bias 15
  const e = exp - 127 + 15;

  // Underflow -> subnormal or zero
  if (e <= 0) {
    if (e < -10) return sign; // too small -> 0
    // subnormal: mantissa with implicit leading 1
    const m = mant | 0x800000;
    const shift = 1 - e;
    // round to nearest even
    const halfMant = (m >>> (shift + 13)) + ((m >>> (shift + 12)) & 1);
    return sign | (halfMant & 0x03ff);
  }

  // Overflow -> Inf
  if (e >= 31) return sign | 0x7c00;

  // Normalized
  // round mantissa: take top 10 bits, with rounding
  const halfExp = e << 10;
  const halfMant = (mant >>> 13) + ((mant >>> 12) & 1); // simple RNE-ish
  return sign | halfExp | (halfMant & 0x03ff);
}

function u8tof16(u8) {
  const res = new Float16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    res[i] = u8[i] / 255;
  }
  return res;
}
