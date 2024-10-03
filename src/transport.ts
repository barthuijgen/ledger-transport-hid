import { StatusCodes, Tag } from "./constants";
import { concatUint8Array, getCodeErrorMessage } from "./utils";

type SendBufferType = {
  cla: number;
  ins: number;
  p1: number;
  p2: number;
  allowedStatusCodes: number[];
  input: ArrayBuffer;
  result: Promise<{
    code: number;
    data: Uint8Array;
  }>;
};

const LOG_LEVEL = {
  NONE: 0,
  INFO: 1,
  DEBUG: 2,
};
type LogLevel = keyof typeof LOG_LEVEL;

export class LedgerTransport {
  logLevel: number;
  packetSize = 64;
  sendBuffer: SendBufferType[] = [];
  inputs: Record<number, HIDInputReportEvent[]> = {};
  inputCallback: Record<number, (event: HIDInputReportEvent) => void> = {};

  constructor(private device: HIDDevice, logLevel: LogLevel = "NONE") {
    this.logLevel = LOG_LEVEL[logLevel] ?? 0;
    this.onInputReport = this.onInputReport.bind(this);
    this.onConnect = this.onConnect.bind(this);
    this.onDisconnect = this.onDisconnect.bind(this);
    device.addEventListener("inputreport", this.onInputReport);
    navigator.hid.addEventListener("connect", this.onConnect);
    navigator.hid.addEventListener("disconnect", this.onDisconnect);
  }

  close() {
    this.device.removeEventListener("inputreport", this.onInputReport);
    this.device.close();
    navigator.hid.removeEventListener("connect", this.onConnect);
    navigator.hid.removeEventListener("disconnect", this.onDisconnect);
  }

  // async sendChunks(
  //   cla: number,
  //   ins: number,
  //   p1: number,
  //   p2: number,
  //   input: ArrayBuffer = new Uint8Array(0),
  // ) {
  //   let chunkSize = 230;
  //   let results = [];
  //   console.log(
  //     `SendChunks ${input.byteLength} bytes in ${Math.ceil(input.byteLength / chunkSize)} chunk(s)`,
  //   );
  //   for (let i = 0; i < input.byteLength; i += chunkSize) {
  //     const result = await this.send(
  //       cla,
  //       ins,
  //       p1,
  //       p2,
  //       input.slice(i, i + chunkSize),
  //     );
  //     results.push(result);
  //   }
  //   return results;
  // }

  async send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    input: ArrayBuffer = new Uint8Array(0),
    allowedStatusCodes: number[] = [StatusCodes.OK]
  ) {
    const wait = Promise.allSettled(this.sendBuffer.map((x) => x.result));
    const result = new Promise<{ code: number; data: Uint8Array }>((resolve) =>
      wait.finally(async () => {
        const result = await this._send(
          cla,
          ins,
          p1,
          p2,
          input,
          allowedStatusCodes
        );
        const index = this.sendBuffer.findIndex((x) => x.cla === cla);
        this.sendBuffer.splice(index, 1);
        resolve(result);
      })
    );
    this.sendBuffer.push({
      cla,
      ins,
      p1,
      p2,
      allowedStatusCodes,
      input,
      result,
    });
    return result;
  }

  private async _send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    input: ArrayBuffer = new Uint8Array(0),
    allowedStatusCodes: number[] = [StatusCodes.OK]
  ) {
    const apdu = concatUint8Array(
      new Uint8Array([cla, ins, p1, p2, input.byteLength]),
      input
    );
    const size = new DataView(new ArrayBuffer(2));
    size.setUint16(0, apdu.length, false);

    const data = concatUint8Array(size.buffer, apdu);
    const blockSize = this.packetSize - 5;
    const nbBlocks = Math.ceil(data.length / blockSize);

    const padded = concatUint8Array(
      data,
      new Uint8Array(nbBlocks * blockSize - data.length + 1)
    );

    const blocks: Uint8Array[] = [];
    const channel = Math.floor(Math.random() * 0xffff);

    for (let i = 0; i < nbBlocks; i++) {
      const head = new DataView(new ArrayBuffer(5));
      head.setUint16(0, channel, false);
      head.setUint8(2, Tag);
      head.setUint16(3, i, false);
      const chunk = padded.slice(i * blockSize, (i + 1) * blockSize);
      blocks.push(concatUint8Array(head.buffer, chunk));
    }

    if (!this.device.opened) {
      await this.device.open();
    }
    if (this.logLevel >= LOG_LEVEL.INFO) {
      console.log(
        "%cMessage to hardware device",
        "color:white;font-weight:bold"
      );
      if (this.logLevel >= LOG_LEVEL.DEBUG) {
        console.log(`[SEND] > (channel ${channel}): ${padded.length} bytes`, [
          ...padded,
        ]);
      } else {
        console.log(`[SEND] > (channel ${channel}): ${padded.length} bytes`);
      }
    }
    for (let i = 0; i < blocks.length; i++) {
      await this.device.sendReport(0, blocks[i]);
    }

    return this.getResponse(allowedStatusCodes, channel);
  }

  onInputReport(event: HIDInputReportEvent) {
    const channel = event.data.getUint16(0, false);
    if (this.logLevel >= LOG_LEVEL.DEBUG) {
      console.log(
        `[RECV] < (channel ${channel}): ${event.data.byteLength} bytes`,
        Array.from(new Uint8Array(event.data.buffer))
      );
    } else if (this.logLevel >= LOG_LEVEL.INFO) {
      console.log(
        `[RECV] < (channel ${channel}): ${event.data.byteLength} bytes`
      );
    }

    if (this.inputCallback[channel]) {
      this.inputCallback[channel](event);
      delete this.inputCallback[channel];
    } else {
      if (!this.inputs[channel]) this.inputs[channel] = [];
      this.inputs[channel].push(event);
    }
  }

  async read(channel: number): Promise<HIDInputReportEvent> {
    if (this.inputs[channel]?.length) {
      return this.inputs[channel].shift() as HIDInputReportEvent;
    } else {
      return new Promise((resolve) => {
        this.inputCallback[channel] = resolve;
      });
    }
  }

  async getResponse(
    allowedStatusCodes: number[],
    channel: number
  ): Promise<{ code: number; data: Uint8Array }> {
    let dataLength = 0;
    let data = new Uint8Array();
    let _channel = channel;

    const read = async () => {
      const event = await this.read(_channel);
      const channel = event.data.getUint16(0, false);
      const tag = event.data.getUint8(2);
      const sequence = event.data.getUint16(3, false);
      const dataIndex = dataLength === 0 ? 7 : 5;

      if (dataLength === 0) {
        dataLength = event.data.getUint16(5, false);
      }

      if (this.logLevel >= LOG_LEVEL.DEBUG) {
        console.log("response", {
          channel,
          tag,
          sequence,
          length: event.data.byteLength,
          dataLength,
          bytes: [...new Uint8Array(event.data.buffer)],
        });
      }

      data = concatUint8Array(data, event.data.buffer.slice(dataIndex));
    };

    await read();
    while (dataLength > data.length) {
      await read();
    }

    const result = data.slice(0, dataLength);
    const dataView = new DataView(result.buffer);
    const code = dataView.getUint16(result.length - 2);

    if (!allowedStatusCodes.includes(code)) {
      throw new Error(getCodeErrorMessage(code));
    }

    return {
      code,
      data: result.slice(0, result.length - 2),
    };
  }

  onConnect(event: HIDConnectionEvent) {
    if (this.logLevel >= LOG_LEVEL.DEBUG) {
      console.log("connect", event);
    }
    this.device = event.device;
    event.device.addEventListener("inputreport", this.onInputReport);
  }

  onDisconnect(event: HIDConnectionEvent) {
    if (this.logLevel >= LOG_LEVEL.DEBUG) {
      console.log("disconnect", event);
    }
    event.device.removeEventListener("inputreport", this.onInputReport);
  }
}
