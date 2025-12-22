import { encodeEXR_RGBA16F } from "./encodeEXR16.js";
import { decodeEXR_RGBA16F } from "./decodeEXR16.js";

export class OpenEXR {
  static encode(imagedataf32) {
    return encodeEXR_RGBA16F(imagedataf32.width, imagedataf32.height, imagedataf32.data);
  }
  static decode(bin) {
    return decodeEXR_RGBA16F(bin);
  }
}
