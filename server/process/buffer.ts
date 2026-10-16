/**
 * The output of one process for re-attaching: raw bytes with an upper bound. Without a terminal emulator on the
 * server, replaying the escape sequences is the only way to rebuild the screen in the browser.
 */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly max: number) {}

  push(b: Buffer): void {
    if (!b.length) return;
    if (b.length >= this.max) {
      this.chunks = [Buffer.from(b.subarray(b.length - this.max))];
      this.size = this.max;
      return;
    }
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.max) {
      const first = this.chunks[0] as Buffer;
      const over = this.size - this.max;
      if (first.length <= over) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(over);
        this.size -= over;
      }
    }
  }

  get length(): number {
    return this.size;
  }

  read(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }

  /** The last n bytes as text (for the screen detection). */
  tail(n: number): string {
    const out: Buffer[] = [];
    let got = 0;
    for (let i = this.chunks.length - 1; i >= 0 && got < n; i--) {
      const c = this.chunks[i] as Buffer;
      out.unshift(c.length > n - got ? c.subarray(c.length - (n - got)) : c);
      got += c.length;
    }
    return Buffer.concat(out).toString("utf8");
  }
}
