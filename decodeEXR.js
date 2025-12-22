// Pure JS minimal OpenEXR decoder (single-part scanline, RGBA FLOAT32)
// compression: NONE(0) / ZIPS(2) / ZIP(3)

import { ByteReader } from "./ByteReader.js";
import { inflate } from "https://taisukef.github.io/zlib.js/es/inflate.js";

/**
 * Decode OpenEXR (scanline, FLOAT RGBA with channels A,B,G,R)
 * Supports compression: NONE(0), ZIPS(2), ZIP(3).
 *
 * @param {Uint8Array|ArrayBuffer} exrBytes
 * @param {object} [opts]
 * @returns {{width:number,height:number,rgba:Float32Array,compression:number}}
 */
export function decodeEXR_RGBA32F(exrBytes) {
  const r = new ByteReader(exrBytes);

  const magic = r.readI32();
  if (magic !== 20000630) throw new Error("not an OpenEXR file (bad magic)");

  const versionField = r.readI32();
  const version = versionField & 0xff;
  if (version !== 2 && version !== 1) {
    // permissive
  }

  // Header: attributes terminated by 0x00
  let channels = null;
  let compression = null;
  let dataWindow = null;

  while (true) {
    const peek = r.u8[r.o];
    if (peek === 0) { r.o += 1; break; } // end header
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

  // only these compressions
  if (compression !== 0 && compression !== 2 && compression !== 3) {
    throw new Error(`unsupported compression: ${compression} (expected 0/2/3)`);
  }
  if ((compression === 2 || compression === 3) && typeof inflate !== "function") {
    throw new TypeError("inflate is required for ZIP/ZIPS");
  }

  const width = dataWindow.xMax - dataWindow.xMin + 1;
  const height = dataWindow.yMax - dataWindow.yMin + 1;

  // Expect channels A,B,G,R FLOAT(2)
  const want = ["A", "B", "G", "R"];
  for (let i = 0; i < want.length; i++) {
    const ch = channels[i];
    if (!ch || ch.name !== want[i] || ch.pixelType !== 2) {
      throw new Error("unsupported channel layout (expected A,B,G,R FLOAT)");
    }
  }

  // blockLines depends on compression
  const blockLines = (compression === 3) ? 16 : 1; // ZIP=16, ZIPS=1, NONE treated as 1
  const numBlocks = Math.ceil(height / blockLines);

  // Offset table: one u64 per block
  const offsets = new Array(numBlocks);
  for (let i = 0; i < numBlocks; i++) offsets[i] = r.readU64();

  const out = new Float32Array(width * height * 4);

  // sizes
  const bytesPerSample = 4;              // float32
  const scanlineBytes = width * 4 * bytesPerSample; // 4ch planar

  // helper: safe u8->f32 (alignment safe)
  const u8ToF32 = (u8) => {
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    return new Float32Array(buf);
  };

  for (let bi = 0; bi < numBlocks; bi++) {
    r.seek(Number(offsets[bi]));

    const y0 = r.readI32();      // first scanline in this block
    const payloadSize = r.readI32();
    const payload = r.readBytes(payloadSize);

    const lines = Math.min(blockLines, height - y0);
    const expectedUncompressed = scanlineBytes * lines;

    let uncompressedU8;

    if (compression === 0) {
      // NONE: payload is uncompressed
      if (payloadSize !== expectedUncompressed) {
        throw new Error("unexpected uncompressed payload size");
      }
      uncompressedU8 = payload;
    } else {
      // ZIP/ZIPS:
      // If compression didn't help, OpenEXR stores uncompressed bytes even though compression flag is ZIP/ZIPS.
      if (payloadSize === expectedUncompressed) {
        uncompressedU8 = payload;
      } else {
        uncompressedU8 = exrZipDecompress(payload, expectedUncompressed, inflate);
      }
    }

    // consume scanlines from uncompressedU8
    let src = 0;
    for (let ly = 0; ly < lines; ly++) {
      const y = y0 + ly;
      const row = y - dataWindow.yMin;
      if (row < 0 || row >= height) {
        src += scanlineBytes;
        continue;
      }

      const aBytes = uncompressedU8.subarray(src, src + width * 4); src += width * 4;
      const bBytes = uncompressedU8.subarray(src, src + width * 4); src += width * 4;
      const gBytes = uncompressedU8.subarray(src, src + width * 4); src += width * 4;
      const rBytes = uncompressedU8.subarray(src, src + width * 4); src += width * 4;

      const A = u8ToF32(aBytes);
      const B = u8ToF32(bBytes);
      const G = u8ToF32(gBytes);
      const R = u8ToF32(rBytes);

      const base = row * width * 4;
      for (let x = 0; x < width; x++) {
        const i = base + x * 4;
        out[i + 0] = R[x];
        out[i + 1] = G[x];
        out[i + 2] = B[x];
        out[i + 3] = A[x];
      }
    }
  }

  return { width, height, data: out };

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
      rr.readBytes(3); // reserved
      const xSampling = rr.readI32();
      const ySampling = rr.readI32();
      out.push({ name, pixelType, pLinear, xSampling, ySampling });
    }
    return out;
  }
}

// ---------- ZIP/ZIPS inverse transform (inflate + unpredictor + unreorder) ----------
function exrZipDecompress(compressedU8, expectedSize, inflate) {
  const predicted = inflate(compressedU8); // should return Uint8Array
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
