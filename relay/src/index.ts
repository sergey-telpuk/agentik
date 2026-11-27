/**
 * The Agentik relay Worker.
 *
 * Its only job is to hand a WebSocket to the Durable Object that serves the
 * requested device. It runs no commands, holds no Noise keys, and reads no
 * signaling contents.
 */

import { DeviceRoom, type Env } from "./device-room";
import { sourceKey } from "./limits";
import { formatDeviceId, parseDeviceId } from "./protocol";

export { DeviceRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // A liveness probe that reveals nothing about connected devices.
      return Response.json({ status: "ok", relay: env.RELAY_ID });
    }

    if (url.pathname !== "/v1/connect") {
      return new Response("not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    // Checked here, before any Durable Object is woken, so a flood of
    // connection attempts from one address costs as little as possible.
    const { success } = await env.CONNECT_LIMITER.limit({ key: sourceKey(request) });
    if (!success) {
      return new Response("too many connection attempts", { status: 429 });
    }

    // The device is named in the query string so the Worker can route
    // without reading any message. It is an opaque public identifier:
    // knowing it grants nothing, since authority is established by the
    // device's signature and by the Noise handshake with the phone.
    const deviceParam = url.searchParams.get("device");
    if (deviceParam === null) {
      return new Response("missing device parameter", { status: 400 });
    }

    const deviceId = parseDeviceId(deviceParam);
    if (deviceId === null) {
      return new Response("malformed device parameter", { status: 400 });
    }

    // Deriving the object name from the identifier means one device always
    // reaches one object, with no mapping table to keep consistent. The name
    // is re-encoded from the parsed bytes rather than taken from the query
    // string, so differences in case or padding cannot send the same device
    // to two different objects.
    const name = formatDeviceId(deviceId);
    const id = env.DEVICE.idFromName(name);
    const room = env.DEVICE.get(id);
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;
