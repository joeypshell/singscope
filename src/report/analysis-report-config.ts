export const ANALYSIS_REPORT_FUNCTION_PATH = '/functions/v1/analysis-report'

function isLocalDevelopmentEndpoint(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  )
}

export function validateAnalysisReportEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('The bug-report endpoint is not a valid URL.')
  }
  if (url.protocol !== 'https:' && !isLocalDevelopmentEndpoint(url)) {
    throw new Error('The bug-report endpoint must use HTTPS.')
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('The bug-report endpoint URL contains unsupported credentials or a fragment.')
  }
  if (url.pathname !== ANALYSIS_REPORT_FUNCTION_PATH || url.search !== '') {
    throw new Error(`The bug-report endpoint must end with ${ANALYSIS_REPORT_FUNCTION_PATH}.`)
  }
  if (!isLocalDevelopmentEndpoint(url) && !/^[a-z0-9]{20}\.supabase\.co$/u.test(url.hostname)) {
    throw new Error('The bug-report endpoint must be the approved Supabase Edge Function.')
  }
  return url.href
}

export function validateSupabasePublishableKey(value: string | undefined): string | undefined {
  const key = value?.trim()
  if (!key) return undefined
  if (!/^sb_publishable_[a-zA-Z0-9_-]{1,2048}$/u.test(key)) {
    throw new Error(
      'Only a current sb_publishable_ Supabase key may be included in the public app.',
    )
  }
  return key
}

export function validateAnalysisReportBuildEnvironment(environment: {
  readonly VITE_SINGSCOPE_REPORT_ENDPOINT?: string | undefined
  readonly VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY?: string | undefined
}): string | null {
  const endpoint = environment.VITE_SINGSCOPE_REPORT_ENDPOINT?.trim()
  validateSupabasePublishableKey(environment.VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY)
  if (!endpoint) return null
  return new URL(validateAnalysisReportEndpoint(endpoint)).origin
}
