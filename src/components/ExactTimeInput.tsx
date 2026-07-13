import { formatTime, parseExactTime } from './time-format'

export interface ExactTimeInputProps {
  readonly label: string
  readonly valueSeconds: number
  readonly onChange: (seconds: number) => void
}

export function ExactTimeInput({ label, valueSeconds, onChange }: ExactTimeInputProps) {
  return (
    <label className="ss-field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        defaultValue={formatTime(valueSeconds)}
        pattern="[0-9]+(:[0-5]?[0-9](\.[0-9]+)?)?"
        onBlur={(event) => {
          const parsed = parseExactTime(event.currentTarget.value)
          if (parsed === null) event.currentTarget.value = formatTime(valueSeconds)
          else onChange(parsed)
        }}
      />
    </label>
  )
}
