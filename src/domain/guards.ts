const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isNonNegativeSeconds(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

export function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

export function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isUtcDate(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_DATE_PATTERN.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

export function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`)
}

export function assertNonNegativeSeconds(value: number, name: string): void {
  assertFinite(value, name)
  if (value < 0) throw new RangeError(`${name} must be at least zero seconds`)
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
