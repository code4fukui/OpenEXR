import { encodeEXR_RGBA32F } from "./encodeEXR.js";
import { decodeEXR_RGBA32F } from "./decodeEXR.js";

export class OpenEXR {
  static encode(imagedataf32) {
    return encodeEXR_RGBA32F(imagedataf32.width, imagedataf32.height, imagedataf32.data);
  }
  static decode(bin) {
    return decodeEXR_RGBA32F(bin);
  }
}
