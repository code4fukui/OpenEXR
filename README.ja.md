# OpenEXR

ZIP圧縮をサポートする最小限のOpenEXRエンコーダ/デコーダです。raw float16およびfloat32の画像バッファのみに対応しています。

## 使い方

```js
import { OpenEXR } from "https://code4fukui.github.io/OpenEXR/OpenEXR.js";

// encode
const w = 320;
const h = 180;
const rgba = new Float16Array(w * h * 4);
for (let i = 0; i < w * h; i++) {
  rgba[i * 4 + 0] = 2.0; // HDR
  rgba[i * 4 + 1] = (Math.cos(i / 20) + 1.0) * 2.0;
  rgba[i * 4 + 2] = Math.sin(i / 320) + 1.0;
  rgba[i * 4 + 3] = 1.0; // i / (w * h); // alpha
}
const exrBytes = OpenEXR.encode({ width: w, height: h, data: rgba });
await Deno.writeFile("example.exr", exrBytes);

// decode
const imgdata16 = OpenEXR.decode(exrBytes);
console.log(imgdata16);

const exrBytes2 =  OpenEXR.encode(imgdata16);
await Deno.writeFile("example2.exr", exrBytes2);
```
- Float32のエンコードにはOpenEXR32.jsを使用してください

## メモ

- f32 NO_COMPRESSION 935KB, ZIP 235KB (320x180)
- f16 NO_COMPRESSION 464KB, ZIP 46KB  (320x180)

## 参考

- [OpenEXR](https://openexr.com/en/latest/)
- [OpenEXR - Wikipedia](https://ja.wikipedia.org/wiki/OpenEXR)

## ライセンス

MIT License — 詳細は [LICENSE](LICENSE) を参照してください。
