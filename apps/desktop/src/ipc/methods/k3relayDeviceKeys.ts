import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopK3RelayDeviceKeys from "../../app/DesktopK3RelayDeviceKeys.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const KeyId = Schema.String.check(
  Schema.makeFilter((keyId: string) => DesktopK3RelayDeviceKeys.isDeviceKeyId(keyId)),
);

export const readK3RelayDeviceKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.K3RELAY_DEVICE_KEY_READ_CHANNEL,
  payload: KeyId,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.k3relayDeviceKeys.read")(function* (keyId) {
    const keys = yield* DesktopK3RelayDeviceKeys.DesktopK3RelayDeviceKeys;
    return Option.getOrNull(yield* keys.read(keyId));
  }),
});

export const writeK3RelayDeviceKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.K3RELAY_DEVICE_KEY_WRITE_CHANNEL,
  payload: Schema.Struct({ keyId: KeyId, secret: Schema.String }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.k3relayDeviceKeys.write")(function* ({ keyId, secret }) {
    const keys = yield* DesktopK3RelayDeviceKeys.DesktopK3RelayDeviceKeys;
    return yield* keys.write(keyId, secret);
  }),
});

export const removeK3RelayDeviceKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.K3RELAY_DEVICE_KEY_REMOVE_CHANNEL,
  payload: KeyId,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.k3relayDeviceKeys.remove")(function* (keyId) {
    const keys = yield* DesktopK3RelayDeviceKeys.DesktopK3RelayDeviceKeys;
    return yield* keys.remove(keyId);
  }),
});
