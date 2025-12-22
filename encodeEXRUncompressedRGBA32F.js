// exr_min_rgba32f.js
// Pure JS minimal OpenEXR (single-part scanline, NO_COMPRESSION, RGBA FLOAT)
// Spec refs: OpenEXR File Layout + predefined attribute types. :contentReference[oaicite:1]{index=1}

import { ByteWriter } from "./ByteWriter.js";

const textEncoder = new TextEncoder();

/**
 * Encode OpenEXR (single-part scanline, NO_COMPRESSION, RGBA FLOAT32)
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} rgbaInterleaved - length = width*height*4 (R,G,B,A)
 * @returns {Uint8Array} .exr bytes
 */
export function encodeEXRUncompressedRGBA32F(width, height, rgbaInterleaved) {
  if (!(rgbaInterleaved instanceof Float32Array)) throw new TypeError("rgbaInterleaved must be Float32Array");
  if (rgbaInterleaved.length !== width * height * 4) throw new RangeError("size mismatch");

  const w = new ByteWriter();

  // Magic number = 20000630 (int32 LE). :contentReference[oaicite:5]{index=5}
  w.i32(20000630);

  // Version field (int32): version=2, set "long names" bit (bit10=0x400) for safety. :contentReference[oaicite:6]{index=6}
  // single-part scanline => bits 9/11/12 = 0. :contentReference[oaicite:7]{index=7}
  w.i32(2 | 0x400);

  // ---- Header attributes (required set) :contentReference[oaicite:8]{index=8} ----
  // channels: chlist
  writeAttribute(w, "channels", "chlist", makeChListRGBA_FLOAT());

  // compression: NO_COMPRESSION = 0 :contentReference[oaicite:9]{index=9}
  writeAttribute(w, "compression", "compression", makeU8(0));

  // dataWindow / displayWindow: box2i = (0,0)-(w-1,h-1) :contentReference[oaicite:10]{index=10}
  const box = makeBox2i(0, 0, width - 1, height - 1);
  writeAttribute(w, "dataWindow", "box2i", box);
  writeAttribute(w, "displayWindow", "box2i", box);

  // lineOrder: INCREASING_Y = 0 :contentReference[oaicite:11]{index=11}
  writeAttribute(w, "lineOrder", "lineOrder", makeU8(0));

  // pixelAspectRatio: float (usually 1.0) :contentReference[oaicite:12]{index=12}
  writeAttribute(w, "pixelAspectRatio", "float", makeF32(1.0));

  // screenWindowCenter: v2f (0,0), screenWindowWidth: float 1 :contentReference[oaicite:13]{index=13}
  writeAttribute(w, "screenWindowCenter", "v2f", makeV2f(0.0, 0.0));
  writeAttribute(w, "screenWindowWidth", "float", makeF32(1.0));

  // end of header: single 0x00 byte :contentReference[oaicite:14]{index=14}
  w.u8(0);

  // ---- Offset table (one offset per scanline block; NO_COMPRESSION => 1 scanline per block) :contentReference[oaicite:15]{index=15}
  const headerEndPos = w.size;
  const numBlocks = height; // 1 scanline per block
  const offsetsPos = headerEndPos;
  // reserve offsets (u64 each)
  for (let i = 0; i < numBlocks; i++) w.u64(0n);

  // We'll generate scanline blocks and also fill offsets.
  // To fill, we need random access; easiest: assemble blocks separately, compute their offsets, then rewrite offsets.
  const blocks = [];
  const bytesPerSample = 4; // FLOAT
  const scanlineDataBytes = width * 4 * bytesPerSample; // 4 channels
  const blockSize = 4 /*y*/ + 4 /*dataSize*/ + scanlineDataBytes;

  // Pixel data layout within scanline block:
  // channels contiguous, channels in alphabetical order by channel name; pixels L->R. :contentReference[oaicite:16]{index=16}
  // With channel names A,B,G,R => write A then B then G then R.
  for (let y = 0; y < height; y++){
    const bw = new ByteWriter();
    bw.i32(y);                // y coordinate :contentReference[oaicite:17]{index=17}
    bw.i32(scanlineDataBytes);// pixel data size :contentReference[oaicite:18]{index=18}

    // Prepare channel planar for this scanline
    const lineA = new Float32Array(width);
    const lineB = new Float32Array(width);
    const lineG = new Float32Array(width);
    const lineR = new Float32Array(width);

    const rowBase = y * width * 4;
    for (let x = 0; x < width; x++){
      const i = rowBase + x * 4;
      const R = rgbaInterleaved[i + 0];
      const G = rgbaInterleaved[i + 1];
      const B = rgbaInterleaved[i + 2];
      const A = rgbaInterleaved[i + 3];
      lineR[x] = R;
      lineG[x] = G;
      lineB[x] = B;
      lineA[x] = A;
    }

    // write as bytes (little-endian float32)
    bw.bytes(new Uint8Array(lineA.buffer));
    bw.bytes(new Uint8Array(lineB.buffer));
    bw.bytes(new Uint8Array(lineG.buffer));
    bw.bytes(new Uint8Array(lineR.buffer));

    const b = bw.finish();
    // sanity
    if (b.byteLength !== blockSize) {
      throw new Error(`internal size mismatch: got ${b.byteLength}, expected ${blockSize}`);
    }
    blocks.push(b);
  }

  // Compute offsets: start of file (0) + offsetTable + blocks
  // Current writer size == headerEndPos + offsetsTableBytes
  const offsetsTableBytes = BigInt(numBlocks) * 8n;
  let runningOffset = BigInt(offsetsPos) + offsetsTableBytes;

  const offsets = new BigUint64Array(numBlocks);
  for (let i = 0; i < numBlocks; i++){
    offsets[i] = runningOffset;
    runningOffset += BigInt(blocks[i].byteLength);
  }

  // Rewrite offsets in-place: easiest rebuild whole file:
  const out = new ByteWriter();
  // magic + version
  out.i32(20000630);
  out.i32(2 | 0x400);

  // header again (same as above) — keep deterministic
  writeAttribute(out, "channels", "chlist", makeChListRGBA_FLOAT());
  writeAttribute(out, "compression", "compression", makeU8(0));
  out.bytes(writeBoxAttr("dataWindow", width, height));
  out.bytes(writeBoxAttr("displayWindow", width, height));
  writeAttribute(out, "lineOrder", "lineOrder", makeU8(0));
  writeAttribute(out, "pixelAspectRatio", "float", makeF32(1.0));
  writeAttribute(out, "screenWindowCenter", "v2f", makeV2f(0.0, 0.0));
  writeAttribute(out, "screenWindowWidth", "float", makeF32(1.0));
  out.u8(0);

  // offsets
  for (let i = 0; i < numBlocks; i++) out.u64(offsets[i]);

  // blocks
  for (const b of blocks) out.bytes(b);

  return out.finish();

  function writeBoxAttr(name, wdt, hgt){
    const bw = new ByteWriter();
    writeAttribute(bw, name, "box2i", makeBox2i(0, 0, wdt - 1, hgt - 1));
    return bw.finish();
  }
}

// ---------- OpenEXR attribute helpers ----------
function writeAttribute(w, name, type, valueBytes){
  w.cstr(name);
  w.cstr(type);
  w.i32(valueBytes.byteLength);
  w.bytes(valueBytes);
}

function makeBox2i(xMin, yMin, xMax, yMax){
  const b = new ArrayBuffer(16);
  const dv = new DataView(b);
  dv.setInt32(0, xMin, true);
  dv.setInt32(4, yMin, true);
  dv.setInt32(8, xMax, true);
  dv.setInt32(12, yMax, true);
  return new Uint8Array(b);
}

function makeV2f(x, y){
  const b = new ArrayBuffer(8);
  const dv = new DataView(b);
  dv.setFloat32(0, x, true);
  dv.setFloat32(4, y, true);
  return new Uint8Array(b);
}

function makeF32(v){
  const b = new ArrayBuffer(4);
  new DataView(b).setFloat32(0, v, true);
  return new Uint8Array(b);
}

function makeU8(v){
  return Uint8Array.of(v & 255);
}

// chlist: sequence of channels + terminating 0x00 :contentReference[oaicite:2]{index=2}
function makeChListRGBA_FLOAT(){
  // IMPORTANT: pixel data stores channels in alphabetical order by name. :contentReference[oaicite:3]{index=3}
  // For RGBA, that order is: A, B, G, R.
  // We'll declare channels with those names and write data in that same order.
  const channels = ["A","B","G","R"];
  const parts = [];
  let total = 0;

  for (const name of channels){
    const nameBytes = textEncoder.encode(name);
    // name\0
    parts.push(nameBytes, Uint8Array.of(0)); total += nameBytes.byteLength + 1;

    // pixel type (int): FLOAT = 2 :contentReference[oaicite:4]{index=4}
    const bType = new ArrayBuffer(4);
    new DataView(bType).setInt32(0, 2, true);
    parts.push(new Uint8Array(bType)); total += 4;

    // pLinear (u8): 0/1 (we set 1)
    parts.push(Uint8Array.of(1)); total += 1;

    // reserved (3 bytes) = 0
    parts.push(Uint8Array.of(0,0,0)); total += 3;

    // xSampling (int), ySampling (int)
    const bS = new ArrayBuffer(8);
    const dvS = new DataView(bS);
    dvS.setInt32(0, 1, true);
    dvS.setInt32(4, 1, true);
    parts.push(new Uint8Array(bS)); total += 8;
  }

  // terminating 0x00
  parts.push(Uint8Array.of(0)); total += 1;

  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts){ out.set(p, o); o += p.byteLength; }
  return out;
}
