/**
 * Feature detection for the data path. There is no alternative transport: a
 * WebView without RTCPeerConnection cannot reach a computer at all, and says
 * so instead of falling back to anything.
 */

export type WebRtcSupport = { readonly supported: true } | { readonly supported: false; readonly reason: string };

export function detectWebRtc(scope: object = globalThis): WebRtcSupport {
  const ctor = (scope as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  if (typeof ctor !== "function") {
    return { supported: false, reason: "this WebView has no RTCPeerConnection" };
  }
  const proto = (ctor as { prototype?: Record<string, unknown> }).prototype;
  if (proto === undefined || typeof proto["createDataChannel"] !== "function") {
    return { supported: false, reason: "this WebView's RTCPeerConnection cannot open a data channel" };
  }
  return { supported: true };
}
