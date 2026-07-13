import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sampleRate = 24_000
const durationSeconds = 8
const melody = [
  [0, 1.5, 261.6256],
  [1.75, 3.25, 293.6648],
  [3.5, 5, 329.6276],
  [5.25, 7.5, 391.9954],
]
const sampleCount = sampleRate * durationSeconds
const dataBytes = sampleCount * 2
const buffer = Buffer.alloc(44 + dataBytes)

buffer.write('RIFF', 0)
buffer.writeUInt32LE(36 + dataBytes, 4)
buffer.write('WAVE', 8)
buffer.write('fmt ', 12)
buffer.writeUInt32LE(16, 16)
buffer.writeUInt16LE(1, 20)
buffer.writeUInt16LE(1, 22)
buffer.writeUInt32LE(sampleRate, 24)
buffer.writeUInt32LE(sampleRate * 2, 28)
buffer.writeUInt16LE(2, 32)
buffer.writeUInt16LE(16, 34)
buffer.write('data', 36)
buffer.writeUInt32LE(dataBytes, 40)

for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate
  const note = melody.find(([start, end]) => time >= start && time < end)
  let sample = 0
  if (note) {
    const [start, end, frequency] = note
    const edge = Math.min(1, (time - start) / 0.02, (end - time) / 0.04)
    sample = Math.sin(2 * Math.PI * frequency * time) * 0.22 * Math.max(0, edge)
  }
  buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await writeFile(resolve(root, 'public', 'demo-reference.wav'), buffer)
