interface ImportMetaEnv {
  readonly VITE_SINGSCOPE_REPORT_ENDPOINT?: string
  readonly VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
