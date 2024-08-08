# Ledger Transport HID

This package provides a alternative to `@ledgerhq/hw-transport-webhid`. I would suggest using that package instead unless you are having problems with it.

Main features of this package:

- Smaller bundle size (No dependencies)
- Only using web-natives so no polyfills needed
- Better error recovery

## Usage

```ts
import { KadenaLedger, StatusCodes } from "ledger-transport-hid";

const [device] = await navigator.hid.requestDevice({
  filters: [{ vendorId: LEDGER_VENDOR_ID }],
});
const transport = new KadenaLedger(device);
```

## Example methods (For the Kadena app)

```ts
await transport.send(
  0x00,
  0x00,
  0x00,
  0x00,
  new Uint8Array(230),
  [StatusCodes.OK, 0x6e01] // 0x6e01 = already open
);

const [major, minor, patch, ...appName] = response.data;
const result = {
  major,
  minor,
  patch,
  appName: new TextDecoder().decode(new Uint8Array(appName)),
};
```
