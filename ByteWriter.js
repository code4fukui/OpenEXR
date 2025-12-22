const textEncoder = new TextEncoder();

export class ByteWriter {
  constructor() {
    this.parts = [];
    this.size = 0;
  }
  u8(v){
    this.parts.push(Uint8Array.of(v & 255));
    this.size += 1;
  }
  i32(v){
    const b = new ArrayBuffer(4);
    new DataView(b).setInt32(0, v, true);
    this.parts.push(new Uint8Array(b)); this.size += 4;
  }
  u32(v){
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, v >>> 0, true);
    this.parts.push(new Uint8Array(b)); this.size += 4;
  }
  u64(vBig){
    // vBig: BigInt
    const b = new ArrayBuffer(8);
    const dv = new DataView(b);
    dv.setUint32(0, Number(vBig & 0xffffffffn), true);
    dv.setUint32(4, Number((vBig >> 32n) & 0xffffffffn), true);
    this.parts.push(new Uint8Array(b)); this.size += 8;
  }
  f32(v){
    const b = new ArrayBuffer(4);
    new DataView(b).setFloat32(0, v, true);
    this.parts.push(new Uint8Array(b)); this.size += 4;
  }
  bytes(u8){
    const a = (u8 instanceof Uint8Array) ? u8 : new Uint8Array(u8);
    this.parts.push(a); this.size += a.byteLength;
  }
  cstr(str){
    const b = textEncoder.encode(str);
    this.parts.push(b); this.parts.push(Uint8Array.of(0));
    this.size += b.byteLength + 1;
  }
  finish(){
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.byteLength; }
    return out;
  }
}
