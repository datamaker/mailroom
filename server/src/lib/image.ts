/**
 * 이미지 바이트를 직접 뜯어본다.
 *
 * 업로드된 파일의 Content-Type 과 확장자는 얼마든지 위조되므로 형식은 매직바이트로
 * 정하고, 크기는 헤더에서 뽑아 에디터가 폭을 맞추는 데 쓴다.
 */

/** 매직바이트로 실제 형식을 알아낸다. 확장자나 Content-Type 은 믿지 않는다. */
export function sniff(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** 이미지 헤더만 읽어 크기를 뽑는다. 에디터가 폭을 맞출 때 쓴다. */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 중 DHT/DAC/RST 제외
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* 못 읽으면 크기 없이 간다 */
  }
  return null;
}
