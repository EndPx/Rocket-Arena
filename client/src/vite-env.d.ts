/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Overrides the Colyseus endpoint the browser dials. Left unset, the client
   * derives it from the page origin: same-origin `wss` behind a TLS proxy,
   * or the local game-server port in dev.
   */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
