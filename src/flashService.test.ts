import { describe, expect, it } from 'vitest'
import { normalizeChipName } from './flashService'

describe('normalizeChipName', () => {
  it.each([
    // esptool-js CHIP_NAME
    ['ESP32-S3', 'esp32s3'],
    ['ESP32', 'esp32'],
    ['ESP8266', 'esp8266'],
    // esptool-js getChipDescription()
    ['ESP32-S3 (QFN56) (revision v0.2)', 'esp32s3'],
    ['ESP32-S3-PICO-1 (LGA56) (revision v0.1)', 'esp32s3'],
    ['ESP32-D0WD-V3 (revision v3.1)', 'esp32'],
    ['ESP32-PICO-D4 (revision v1.0)', 'esp32'],
    ['ESP32-S0WD (revision v1.0)', 'esp32'],
    ['ESP32-C3 (revision v0.4)', 'esp32c3'],
    // The unrecognised-package fallback: prefixed, so must not be anchored.
    ['unknown ESP32-S3 (revision v0.0)', 'esp32s3'],
    ['Unknown ESP32', 'esp32'],
    // manifest / sdkconfig style
    ['esp32s3', 'esp32s3'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeChipName(input)).toBe(expected)
  })

  it('returns null when no family can be identified', () => {
    expect(normalizeChipName('')).toBeNull()
    expect(normalizeChipName('Unknown')).toBeNull()
  })

  it('does not confuse an ESP32 with an ESP32-S3', () => {
    expect(normalizeChipName('ESP32-D0WD')).not.toBe(normalizeChipName('ESP32-S3 (QFN56)'))
  })
})
