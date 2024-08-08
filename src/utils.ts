import { StatusCodes } from "./constants";

export function concatUint8Array(...buffers: ArrayBuffer[]): Uint8Array {
  const totalLength = buffers.reduce(
    (sum, buffer) => sum + buffer.byteLength,
    0
  );
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const buffer of buffers) {
    result.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }

  return result;
}

export function getCodeErrorMessage(code: number) {
  const status = Object.entries(StatusCodes).find(([_, x]) => code === x);
  const byName = status ? status[0] + " / " : "";
  return `Error status code: ${byName}${code} / 0x${code.toString(16)}`;
}
