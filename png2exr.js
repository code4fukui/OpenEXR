import { PNG } from "https://code4fukui.github.io/PNG/PNG.js";
import { OpenEXR } from "./OpenEXR.js";

export const png2exr = (bin) => {
  const img = PNG.decode(bin);
  return OpenEXR.encode(img);
};
