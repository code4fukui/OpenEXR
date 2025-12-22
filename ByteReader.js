const textDecoder = new TextDecoder();

export class ByteReader {
  constructor(u8){
    this.u8 = (u8 instanceof Uint8Array) ? u8 : new Uint8Array(u8);
    this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.o = 0;
  }
  seek(pos){ this.o = pos; }
  tell(){ return this.o; }
  readU8(){ return this.u8[this.o++]; }
  readI32(){ const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  readU32(){ const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  readU64(){
    const lo = this.dv.getUint32(this.o, true);
    const hi = this.dv.getUint32(this.o + 4, true);
    this.o += 8;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  readF32(){ const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  readBytes(n){ const s = this.u8.subarray(this.o, this.o + n); this.o += n; return s; }
  readCStr(){
    const start = this.o;
    while (this.o < this.u8.length && this.u8[this.o] !== 0) this.o++;
    const s = textDecoder.decode(this.u8.subarray(start, this.o));
    this.o++; // skip null
    return s;
  }
}
