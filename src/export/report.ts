import { escapeHtml } from './safety'

export interface StaticReportInput {
  title: string
  projectName: string
  takeLabel: string
  recordedAt: string
  metadata?: Readonly<Record<string, number | string | null>>
  metrics: Readonly<Record<string, number | string | null>>
  notes?: readonly string[]
}

export function createStaticReport(input: StaticReportInput): string {
  const metadataRows = Object.entries(input.metadata ?? {})
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value === null ? 'Not available' : String(value))}</td></tr>`,
    )
    .join('')
  const metricRows = Object.entries(input.metrics)
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value === null ? 'Not available' : String(value))}</td></tr>`,
    )
    .join('')
  const notes = (input.notes ?? []).map((note) => `<li>${escapeHtml(note)}</li>`).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;color:#17211d;background:#fff;max-width:52rem;margin:auto;padding:2rem}h1{line-height:1.15}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccd7d1;padding:.6rem;text-align:left}th{width:55%}img{display:block;max-width:100%;height:auto;margin:1.5rem 0}.meta{color:#4e5d55}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(input.title)}</h1>
<p class="meta">Project: ${escapeHtml(input.projectName)} · Take: ${escapeHtml(input.takeLabel)} · ${escapeHtml(input.recordedAt)}</p>
<img src="pitch-chart.png" alt="Pitch accuracy chart">
<p><strong>Chart legend:</strong> blue bars are target notes; red dots are raw detected pitch; the solid red trace is display smoothing; hatched ranges are unscored gaps.</p>
${metadataRows.length > 0 ? `<h2>Session details</h2><table><tbody>${metadataRows}</tbody></table>` : ''}
<h2>Transparent metrics</h2>
<table><tbody>${metricRows}</tbody></table>
${notes.length > 0 ? `<h2>Notes</h2><ul>${notes}</ul>` : ''}
<p>This report contains no scripts or network requests. Low-confidence and missing intervals remain unscored. Automatic measurements are coaching aids, not medical advice.</p>
</main>
</body>
</html>`
}
