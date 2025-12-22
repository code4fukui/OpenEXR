import { encodeEXRUncompressedRGBA32F } from "./encodeEXRUncompressedRGBA32F.js";
import { decodeEXRUncompressedRGBA32F } from "./decodeEXRUncompressedRGBA32F.js";

export class OpenEXR {
  static encode(imagedataf32) {
    return encodeEXRUncompressedRGBA32F(imagedataf32.width, imagedataf32.height, imagedataf32.data);
  }
  static decode(bin) {
    return decodeEXRUncompressedRGBA32F(bin);
  }
}
