declare module "pngjs" {
  export interface PngImage {
    width: number;
    height: number;
    data: Uint8Array;
  }

  export class PNG implements PngImage {
    width: number;
    height: number;
    data: Uint8Array;
    constructor(options: { width: number; height: number });
    static sync: {
      read(buffer: Buffer): PNG;
      write(image: PNG): Buffer;
    };
  }
}

declare module "pixelmatch" {
  import type { PngImage } from "pngjs";
  export default function pixelmatch(
    image1: Uint8Array,
    image2: Uint8Array,
    output: Uint8Array,
    width: number,
    height: number,
    options?: { threshold?: number },
  ): number;
}
