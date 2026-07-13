export interface MetricDisplay {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly detail?: string
}

export interface MetricGridProps {
  readonly metrics: readonly MetricDisplay[]
}

export function MetricGrid({ metrics }: MetricGridProps) {
  return (
    <dl className="ss-metric-grid">
      {metrics.map((metric) => (
        <div key={metric.id}>
          <dt>{metric.label}</dt>
          <dd>{metric.value}</dd>
          {metric.detail ? <small>{metric.detail}</small> : null}
        </div>
      ))}
    </dl>
  )
}
