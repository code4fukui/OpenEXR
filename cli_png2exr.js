import { png2exr } from "./png2exr.js";
import { EXT } from "https://code4fukui.github.io/EXT/EXT.js";

const fn = Deno.args[0];
if (!fn) {
  console.log("png2exr [fn]");
  Deno.exit(1);
}
const fn2 = EXT.set(fn, "exr");

const bin = await Deno.readFile(fn);
const exrbin = png2exr(bin);
await Deno.writeFile(fn2, exrbin);
