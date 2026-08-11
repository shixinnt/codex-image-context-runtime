import { fail } from "./errors.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function parsePngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    fail("INVALID_IMAGE_PAYLOAD", "image is not a valid PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8192 || height > 8192) fail("INVALID_IMAGE_PAYLOAD", "PNG dimensions are unsupported");
  return { width, height };
}

function parseJpegDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail("INVALID_IMAGE_PAYLOAD", "image is not a valid JPEG");
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]).has(marker)) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > 8192 || height > 8192) fail("INVALID_IMAGE_PAYLOAD", "JPEG dimensions are unsupported");
      return { width, height };
    }
    offset += length;
  }
  fail("INVALID_IMAGE_PAYLOAD", "JPEG dimensions are unavailable");
}

export function inspectImageFormat(bytes, relativePath = "") {
  if (Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { media_type: "image/png", dimensions: parsePngDimensions(bytes) };
  }
  if (Buffer.isBuffer(bytes) && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { media_type: "image/jpeg", dimensions: parseJpegDimensions(bytes) };
  }
  if (/\.webp$/i.test(relativePath) && Buffer.isBuffer(bytes) && bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { media_type: "image/webp", dimensions: null };
  }
  fail("UNSUPPORTED_IMAGE_FORMAT", "only PNG, JPEG, and bounded WebP inputs are supported");
}
