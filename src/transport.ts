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

export class LedgerTransport {
  packetSize = 64;
  sendBuffer: SendBufferType[] = [];
  inputs: Record<number, HIDInputReportEvent[]> = {};
  inputCallback: Record<number, (event: HIDInputReportEvent) => void> = {};

  constructor(private device: HIDDevice) {
    device.addEventListener("inputreport", this.onInputReport.bind(this));
    navigator.hid.addEventListener("connect", this.onConnect.bind(this));
    navigator.hid.addEventListener("disconnect", this.onDisconnect.bind(this));
  }

  close() {
    this.device.removeEventListener(
      "inputreport",
      this.onInputReport.bind(this)
    );
    this.device.close();
    navigator.hid.removeEventListener("connect", this.onConnect.bind(this));
    navigator.hid.removeEventListener(
      "disconnect",
      this.onDisconnect.bind(this)
    );
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

    // console.log(
    //   `Sending payload of ${blocks.length} blocks (open: ${this.device.opened})`,
    // );

    if (!this.device.opened) {
      await this.device.open();
    }
    console.log("%cMessage to hardware device", "color:white;font-weight:bold");
    console.log(`[SEND] > (channel ${channel}): ${padded.length} bytes`);
    for (let i = 0; i < blocks.length; i++) {
      await this.device.sendReport(0, blocks[i]);
    }

    return this.getResponse(allowedStatusCodes, channel);
  }

  onInputReport(event: HIDInputReportEvent) {
    const channel = event.data.getUint16(0, false);
    console.log(
      `[RECV] < (channel ${channel}): ${event.data.byteLength} bytes`
    );

    // console.log([...new Uint8Array(event.data.buffer)]);
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

      // console.log('response', {
      //   channel,
      //   tag,
      //   sequence,
      //   length: event.data.byteLength,
      //   dataLength,
      // });

      data = concatUint8Array(data, event.data.buffer.slice(dataIndex));
    };

    await read();
    while (dataLength > data.length) {
      await read();
    }

    const result = data.slice(0, dataLength);
    // console.log('result', [...result]);

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
    // console.log("connect", event);
    this.device = event.device;
    event.device.addEventListener("inputreport", this.onInputReport.bind(this));
  }

  onDisconnect(event: HIDConnectionEvent) {
    // console.log("disconnect", event);
    event.device.removeEventListener(
      "inputreport",
      this.onInputReport.bind(this)
    );
  }
}
