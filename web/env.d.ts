/// <reference types="vite/client" />

// #1581: the web's build-time flags (vite.config.ts maps the deploy's old names onto them).
interface ImportMetaEnv {
  readonly VITE_API_MOCKS?: string;
  readonly VITE_ORACLE_SIMPLE_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
