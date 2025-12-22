import { encodeEXR_RGBA16F } from "./encodeEXR16.js";
import { decodeEXR_RGBA16F } from "./decodeEXR16.js";

export class OpenEXR {
  static encode(imagedataf16) {
    return encodeEXR_RGBA16F(imagedataf16.width, imagedataf16.height, imagedataf16.data);
  }
  static decode(bin) {
    return decodeEXR_RGBA16F(bin);
  }
}
