import { OpenEXR } from "./OpenEXR.js";

// encode
const w = 320;
const h = 180;
const rgba = new Float32Array(w * h * 4);
for (let i = 0; i < w * h; i++) {
  rgba[i * 4 + 0] = 2.0; // HDR
  rgba[i * 4 + 1] = Math.cos(i / 20) + 1.0;
  rgba[i * 4 + 2] = 2.1;
  rgba[i * 4 + 3] = 1.0; // i / (w * h); // alpha
}
const exrBytes = OpenEXR.encode({ width: w, height: h, data: rgba });
await Deno.writeFile("example.exr", exrBytes);

// decode
const { width, height, rgba: back } = OpenEXR.decode(exrBytes);
console.log(width, height, back);

const exrBytes2 =  OpenEXR.encode({ width, height, data: back });
await Deno.writeFile("example.exr", exrBytes2);
