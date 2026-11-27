/// <reference types="vite/client" />
declare const __APP_VERSION__: string;

declare module "*.css";

declare module "*.svg" {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  readonly VITE_AGENTIK_STUN_URLS?: string;
  readonly VITE_AGENTIK_CONNECT_TIMEOUT_MS?: string;
  readonly VITE_AGENTIK_ICE_SERVERS_WAIT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
