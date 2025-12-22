// exr_min_rgba32f.js
// Pure JS minimal OpenEXR (single-part scanline, NO_COMPRESSION, RGBA FLOAT)
// Spec refs: OpenEXR File Layout + predefined attribute types. :contentReference[oaicite:1]{index=1}

import { ByteReader } from "./ByteReader.js";

/**
 * Decode OpenEXR produced by encodeEXRUncompressedRGBA32F (and similar: scanline, NO_COMPRESSION, FLOAT RGBA)
 * @param {Uint8Array|ArrayBuffer} exrBytes
 * @returns {{width:number,height:number,rgba:Float32Array}}
 */
export function decodeEXRUncompressedRGBA32F(exrBytes){
  const r = new ByteReader(exrBytes);

  const magic = r.readI32();
  if (magic !== 20000630) throw new Error("not an OpenEXR file (bad magic)"); // :contentReference[oaicite:19]{index=19}

  const versionField = r.readI32();
  const version = versionField & 0xff;
  if (version !== 2 && version !== 1) {
    // v1 scanline is also structurally similar, but we only aim for v2-ish.
    // keep permissive.
  }

  // Header: sequence of attributes terminated by 0x00 :contentReference[oaicite:20]{index=20}
  let channels = null;
  let compression = null;
  let dataWindow = null;

  while (true){
    const peek = r.u8[r.o];
    if (peek === 0) { r.o += 1; break; } // end of header
    const name = r.readCStr();
    const type = r.readCStr();
    const size = r.readI32();
    const valuePos = r.tell();
    const value = r.readBytes(size);

    if (name === "channels" && type === "chlist") channels = parseChList(value);
    else if (name === "compression" && type === "compression") compression = value[0];
    else if (name === "dataWindow" && type === "box2i") dataWindow = parseBox2i(value);

    // (ignore others)
    // ensure we consumed exactly size bytes (already did)
    if (r.tell() !== valuePos + size) throw new Error("attribute parse mismatch");
  }

  if (!channels) throw new Error("missing channels");
  if (compression !== 0) throw new Error("only NO_COMPRESSION supported"); // :contentReference[oaicite:21]{index=21}
  if (!dataWindow) throw new Error("missing dataWindow");

  const width = dataWindow.xMax - dataWindow.xMin + 1;
  const height = dataWindow.yMax - dataWindow.yMin + 1;

  // Offset table: one u64 per scanline block, ordered by increasing y. :contentReference[oaicite:22]{index=22}
  const numBlocks = height;
  const offsets = new Array(numBlocks);
  for (let i = 0; i < numBlocks; i++) offsets[i] = r.readU64();

  // We expect channel names exactly A,B,G,R and pixelType FLOAT(2)
  const want = ["A","B","G","R"];
  for (let i = 0; i < want.length; i++){
    const ch = channels[i];
    if (!ch || ch.name !== want[i] || ch.pixelType !== 2) {
      throw new Error("unsupported channel layout (expected A,B,G,R FLOAT)");
    }
  }

  const out = new Float32Array(width * height * 4);

  // Read blocks
  const bytesPerSample = 4;
  const scanlineDataBytes = width * 4 * bytesPerSample;

  const u8ToF32 = (u8) => {
    const buf = u8.buffer.slice(
      u8.byteOffset,
      u8.byteOffset + u8.byteLength
    );
    return new Float32Array(buf);
  };

  for (let bi = 0; bi < numBlocks; bi++){
    r.seek(Number(offsets[bi]));
    const y = r.readI32();
    const dataSize = r.readI32();
    if (dataSize !== scanlineDataBytes) throw new Error("unexpected scanline data size");

    // A,B,G,R planar arrays
    const aBytes = r.readBytes(width * 4);
    const bBytes = r.readBytes(width * 4);
    const gBytes = r.readBytes(width * 4);
    const rBytes = r.readBytes(width * 4);

    const A = u8ToF32(aBytes);
    const B = u8ToF32(bBytes);
    const G = u8ToF32(gBytes);
    const R = u8ToF32(rBytes);
    
    const row = y - dataWindow.yMin;
    if (row < 0 || row >= height) continue;

    const base = row * width * 4;
    for (let x = 0; x < width; x++){
      const i = base + x * 4;
      out[i+0] = R[x];
      out[i+1] = G[x];
      out[i+2] = B[x];
      out[i+3] = A[x];
    }
  }

  return { width, height, rgba: out };

  function parseBox2i(u8){
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return {
      xMin: dv.getInt32(0, true),
      yMin: dv.getInt32(4, true),
      xMax: dv.getInt32(8, true),
      yMax: dv.getInt32(12, true),
    };
  }

  function parseChList(u8){
    // chlist: repeated channel records terminated by 0x00 byte. :contentReference[oaicite:23]{index=23}
    const rr = new ByteReader(u8);
    const out = [];
    while (rr.o < u8.length){
      if (rr.u8[rr.o] === 0) { rr.o += 1; break; }
      const name = rr.readCStr();
      const pixelType = rr.readI32(); // 0/1/2 (UINT/HALF/FLOAT) :contentReference[oaicite:24]{index=24}
      const pLinear = rr.readU8();
      rr.readBytes(3); // reserved
      const xSampling = rr.readI32();
      const ySampling = rr.readI32();
      out.push({ name, pixelType, pLinear, xSampling, ySampling });
    }
    return out;
  }
}