// Pure JS minimal OpenEXR decoder (single-part scanline, RGBA HALF)
// compression: NONE(0) / ZIPS(2) / ZIP(3)

import { ByteReader } from "./ByteReader.js";
import { inflate } from "https://taisukef.github.io/zlib.js/es/inflate.js";

/**
 * Decode OpenEXR (scanline, HALF RGBA with channels A,B,G,R)
 * Supports compression: NONE(0), ZIPS(2), ZIP(3).
 *
 * @param {Uint8Array|ArrayBuffer} exrBytes
 * @returns {{width:number,height:number,rgba:Float16Array,compression:number}}
 */
export function decodeEXR_RGBA16F(exrBytes) {
  const r = new ByteReader(exrBytes);

  const magic = r.readI32();
  if (magic !== 20000630) throw new Error("not an OpenEXR file (bad magic)");

  const versionField = r.readI32();
  const version = versionField & 0xff;
  if (version !== 2 && version !== 1) {
    // permissive
  }

  // Header
  let channels = null;
  let compression = null;
  let dataWindow = null;

  while (true) {
    const peek = r.u8[r.o];
    if (peek === 0) { r.o += 1; break; }
    const name = r.readCStr();
    const type = r.readCStr();
    const size = r.readI32();
    const valuePos = r.tell();
    const value = r.readBytes(size);

    if (name === "channels" && type === "chlist") channels = parseChList(value);
    else if (name === "compression" && type === "compression") compression = value[0];
    else if (name === "dataWindow" && type === "box2i") dataWindow = parseBox2i(value);

    if (r.tell() !== valuePos + size) throw new Error("attribute parse mismatch");
  }

  if (!channels) throw new Error("missing channels");
  if (compression == null) throw new Error("missing compression");
  if (!dataWindow) throw new Error("missing dataWindow");

  if (compression !== 0 && compression !== 2 && compression !== 3) {
    throw new Error(`unsupported compression: ${compression} (expected 0/2/3)`);
  }

  const width = dataWindow.xMax - dataWindow.xMin + 1;
  const height = dataWindow.yMax - dataWindow.yMin + 1;

  // Expect channels A,B,G,R HALF(1)
  const want = ["A", "B", "G", "R"];
  for (let i = 0; i < want.length; i++) {
    const ch = channels[i];
    if (!ch || ch.name !== want[i] || ch.pixelType !== 1) {
      throw new Error("unsupported channel layout (expected A,B,G,R HALF)");
    }
  }

  const blockLines = (compression === 3) ? 16 : 1;
  const numBlocks = Math.ceil(height / blockLines);

  // Offset table
  const offsets = new Array(numBlocks);
  for (let i = 0; i < numBlocks; i++) offsets[i] = r.readU64();

  const out = new Float16Array(width * height * 4);

  // sizes
  const bytesPerSample = 2; // half
  const scanlineBytes = width * 4 * bytesPerSample; // A,B,G,R planar (half)
  const expectedScanlinePayload = scanlineBytes;     // per 1 line

  for (let bi = 0; bi < numBlocks; bi++) {
    r.seek(Number(offsets[bi]));

    const y0 = r.readI32();
    const payloadSize = r.readI32();
    const payload = r.readBytes(payloadSize);

    const lines = Math.min(blockLines, height - y0);
    const expectedUncompressed = scanlineBytes * lines;

    let uncompressedU8;

    if (compression === 0) {
      if (payloadSize !== expectedUncompressed) throw new Error("unexpected uncompressed payload size");
      uncompressedU8 = payload;
    } else {
      // ZIP/ZIPS: if compression not smaller, payload is raw
      if (payloadSize === expectedUncompressed) {
        uncompressedU8 = payload;
      } else {
        uncompressedU8 = exrZipDecompress(payload, expectedUncompressed, inflate);
      }
    }

    // Iterate scanlines within block
    let src = 0;
    for (let ly = 0; ly < lines; ly++) {
      const y = y0 + ly;
      const row = y - dataWindow.yMin;
      if (row < 0 || row >= height) {
        src += expectedScanlinePayload;
        continue;
      }

      const aU8 = uncompressedU8.subarray(src, src + width * 2); src += width * 2;
      const bU8 = uncompressedU8.subarray(src, src + width * 2); src += width * 2;
      const gU8 = uncompressedU8.subarray(src, src + width * 2); src += width * 2;
      const rU8 = uncompressedU8.subarray(src, src + width * 2); src += width * 2;

      // Convert half bytes to float32 arrays
      const A = u8ToU16Aligned(aU8);
      const B = u8ToU16Aligned(bU8);
      const G = u8ToU16Aligned(gU8);
      const R = u8ToU16Aligned(rU8);

      const base = row * width * 4;
      for (let x = 0; x < width; x++) {
        const i = base + x * 4;
        out[i + 0] = f16BitsToF32(R[x]);
        out[i + 1] = f16BitsToF32(G[x]);
        out[i + 2] = f16BitsToF32(B[x]);
        out[i + 3] = f16BitsToF32(A[x]);
      }
    }
  }

  return { width, height, rgba: out, compression };

  function parseBox2i(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return {
      xMin: dv.getInt32(0, true),
      yMin: dv.getInt32(4, true),
      xMax: dv.getInt32(8, true),
      yMax: dv.getInt32(12, true),
    };
  }

  function parseChList(u8) {
    const rr = new ByteReader(u8);
    const out = [];
    while (rr.o < u8.length) {
      if (rr.u8[rr.o] === 0) { rr.o += 1; break; }
      const name = rr.readCStr();
      const pixelType = rr.readI32(); // 0/1/2
      const pLinear = rr.readU8();
      rr.readBytes(3);
      const xSampling = rr.readI32();
      const ySampling = rr.readI32();
      out.push({ name, pixelType, pLinear, xSampling, ySampling });
    }
    return out;
  }
}

// ---------- ZIP/ZIPS inverse transform ----------
function exrZipDecompress(compressedU8, expectedSize, inflate) {
  const predicted = inflate(compressedU8);
  if (!(predicted instanceof Uint8Array)) {
    throw new TypeError("inflate must return Uint8Array");
  }
  if (predicted.byteLength !== expectedSize) {
    throw new Error(`inflate size mismatch: got ${predicted.byteLength}, expected ${expectedSize}`);
  }
  const reordered = exrZipUnpredictor(predicted);
  return exrZipUnreorder(reordered);
}

function exrZipUnreorder(u8) {
  const n = u8.length;
  const out = new Uint8Array(n);
  let t1 = 0;
  let t2 = (n + 1) >> 1;
  for (let i = 0; i < n; i++) {
    out[i] = u8[(i & 1) ? t2++ : t1++];
  }
  return out;
}

function exrZipUnpredictor(u8) {
  const out = u8.slice();
  for (let i = 1; i < out.length; i++) {
    out[i] = (out[i - 1] + out[i] - 128) & 255;
  }
  return out;
}

// ---------- alignment-safe Uint8Array -> Uint16Array view ----------
function u8ToU16Aligned(u8) {
  // Ensure byteOffset aligned for Uint16Array
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return new Uint16Array(buf);
}

// ---------- half bits -> float32 ----------
/**
 * Convert IEEE-754 half float bits (uint16) to JS number (float32-ish).
 */
function f16BitsToF32(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp  = (h >>> 10) & 0x1f;
  const mant = h & 0x03ff;

  if (exp === 0) {
    // subnormal or zero
    if (mant === 0) return sign * 0;
    return sign * Math.pow(2, -14) * (mant / 1024);
  }
  if (exp === 31) {
    // inf or NaN
    if (mant === 0) return sign * Infinity;
    return NaN;
  }
  // normal
  return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
}
