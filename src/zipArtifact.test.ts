import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractFirmwareZip, parsePartitionTable } from './zipArtifact'

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

type PartitionSpec = {
  label: string
  type: number
  subType: number
  offset: number
  size: number
}

const buildPartitionTable = (specs: PartitionSpec[]): Uint8Array => {
  const bytes = new Uint8Array(0x1000).fill(0xff)
  const view = new DataView(bytes.buffer)
  specs.forEach((spec, index) => {
    const at = index * 32
    view.setUint16(at, 0x50aa, true) // bytes AA 50, as ESP-IDF writes them
    view.setUint8(at + 2, spec.type)
    view.setUint8(at + 3, spec.subType)
    view.setUint32(at + 4, spec.offset, true)
    view.setUint32(at + 8, spec.size, true)
    bytes.fill(0x00, at + 12, at + 32) // ESP-IDF NUL-pads the label + flags
    bytes.set(new TextEncoder().encode(spec.label).subarray(0, 16), at + 12)
  })
  return bytes
}

/** Minimal ESP image: magic 0xE9, dio/8MB/80m, chip id at bytes 12..13. */
const buildEspImage = (chipId: number, length: number): Uint8Array => {
  const bytes = new Uint8Array(length)
  bytes[0] = 0xe9
  bytes[1] = 4 // segment count
  bytes[2] = 2 // dio
  bytes[3] = 0x3f // 8MB / 80m
  bytes[12] = chipId & 0xff
  bytes[13] = (chipId >> 8) & 0xff
  return bytes
}

const ESP32S3 = 0x0009

const APP = 0x00
const DATA = 0x01
const SUB_FACTORY = 0x00
const SUB_OTA_0 = 0x10
const SUB_OTADATA = 0x00
const SUB_PHY = 0x01
const SUB_NVS = 0x02

/** gm_radar's current partitions_two_ota.csv. */
const newLayout: PartitionSpec[] = [
  { label: 'nvs', type: DATA, subType: SUB_NVS, offset: 0x9000, size: 0x6000 },
  { label: 'otadata', type: DATA, subType: SUB_OTADATA, offset: 0xf000, size: 0x2000 },
  { label: 'phy_init', type: DATA, subType: SUB_PHY, offset: 0x11000, size: 0x1000 },
  { label: 'factory', type: APP, subType: SUB_FACTORY, offset: 0x20000, size: 0x200000 },
  { label: 'ota_0', type: APP, subType: SUB_OTA_0, offset: 0x220000, size: 0x200000 },
  { label: 'ota_1', type: APP, subType: SUB_OTA_0 + 1, offset: 0x420000, size: 0x200000 },
]

/** The layout the Flash tab used to hardcode. */
const oldLayout: PartitionSpec[] = [
  { label: 'nvs', type: DATA, subType: SUB_NVS, offset: 0x9000, size: 0x4000 },
  { label: 'otadata', type: DATA, subType: SUB_OTADATA, offset: 0xd000, size: 0x2000 },
  { label: 'phy_init', type: DATA, subType: SUB_PHY, offset: 0xf000, size: 0x1000 },
  { label: 'factory', type: APP, subType: SUB_FACTORY, offset: 0x10000, size: 0x100000 },
  { label: 'ota_0', type: APP, subType: SUB_OTA_0, offset: 0x110000, size: 0x100000 },
]

const manifestFor = (otaDataAddress: number, appAddress: number): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      flash_settings: { flash_mode: 'dio', flash_size: '8MB', flash_freq: '80m' },
      flash_files: {
        '0x0': 'bootloader/bootloader.bin',
        '0x8000': 'partition_table/partition-table.bin',
        [`0x${otaDataAddress.toString(16)}`]: 'ota_data_initial.bin',
        [`0x${appAddress.toString(16)}`]: 'mmwave_radar2_idf.bin',
      },
      extra_esptool_args: { chip: 'esp32s3' },
    }),
  )

type ZipParts = {
  layout: PartitionSpec[]
  manifest?: Uint8Array
  extra?: Record<string, Uint8Array>
}

/** CI flattens the build dir, so the zip has bare basenames. */
const buildZip = ({ layout, manifest, extra }: ZipParts): File => {
  const files: Record<string, Uint8Array> = {
    'bootloader.bin': buildEspImage(ESP32S3, 0x2000),
    'partition-table.bin': buildPartitionTable(layout),
    'ota_data_initial.bin': new Uint8Array(0x2000).fill(0xff),
    'mmwave_radar2_idf.bin': buildEspImage(ESP32S3, 0x1000),
    ...extra,
  }
  if (manifest) {
    files['flasher_args.json'] = manifest
  }
  const zipped = zipSync(files)
  return new File([zipped], 'gm_radar-wifi-1.zip', { type: 'application/zip' })
}

const addressOf = (
  summary: Awaited<ReturnType<typeof extractFirmwareZip>>,
  name: string,
): number | undefined => summary.entries.find((entry) => entry.name === name)?.address

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('parsePartitionTable', () => {
  it('reads offsets, sizes and labels, and stops at the first non-partition record', () => {
    const parsed = parsePartitionTable(buildPartitionTable(newLayout))
    expect(parsed).toHaveLength(newLayout.length)
    expect(parsed[1]).toMatchObject({ label: 'otadata', offset: 0xf000, size: 0x2000 })
    expect(parsed[3]).toMatchObject({ label: 'factory', offset: 0x20000 })
  })
})

describe('extractFirmwareZip', () => {
  it('takes addresses from flasher_args.json for the current gm_radar layout', async () => {
    const summary = await extractFirmwareZip(
      buildZip({ layout: newLayout, manifest: manifestFor(0xf000, 0x20000) }),
    )

    expect(summary.errors).toEqual([])
    expect(summary.layoutSource).toBe('manifest')
    expect(addressOf(summary, 'bootloader.bin')).toBe(0x0)
    expect(addressOf(summary, 'partition-table.bin')).toBe(0x8000)
    expect(addressOf(summary, 'ota_data_initial.bin')).toBe(0xf000)
    expect(addressOf(summary, 'mmwave_radar2_idf.bin')).toBe(0x20000)
    expect(summary.chipName).toBe('esp32s3')
    expect(summary.flashParams).toMatchObject({ mode: 'dio', size: '8MB', freq: '80m' })
  })

  it('derives the current layout from partition-table.bin when no manifest is present', async () => {
    const summary = await extractFirmwareZip(buildZip({ layout: newLayout }))

    expect(summary.errors).toEqual([])
    expect(summary.layoutSource).toBe('partition-table')
    expect(addressOf(summary, 'ota_data_initial.bin')).toBe(0xf000)
    expect(addressOf(summary, 'mmwave_radar2_idf.bin')).toBe(0x20000)
  })

  it('still flashes older builds at their own addresses', async () => {
    const summary = await extractFirmwareZip(
      buildZip({ layout: oldLayout, manifest: manifestFor(0xd000, 0x10000) }),
    )

    expect(summary.errors).toEqual([])
    expect(addressOf(summary, 'ota_data_initial.bin')).toBe(0xd000)
    expect(addressOf(summary, 'mmwave_radar2_idf.bin')).toBe(0x10000)
  })

  it('blocks the regression: old addresses against the current partition table', async () => {
    // Exactly what the hardcoded UI used to do with a current CI artifact:
    // ota_data into nvs, and the app into the gap before `factory`.
    const summary = await extractFirmwareZip(
      buildZip({ layout: newLayout, manifest: manifestFor(0xd000, 0x10000) }),
    )

    expect(summary.errors.length).toBeGreaterThan(0)
    expect(summary.errors.join('\n')).toContain('ota_data_initial.bin')
    expect(summary.errors.join('\n')).toContain('mmwave_radar2_idf.bin')
  })

  it('rejects a bootloader placed at the wrong offset for the detected chip', async () => {
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        flash_files: {
          '0x1000': 'bootloader.bin', // esp32 offset, but these are esp32s3 images
          '0x8000': 'partition-table.bin',
          '0xf000': 'ota_data_initial.bin',
          '0x20000': 'mmwave_radar2_idf.bin',
        },
        extra_esptool_args: { chip: 'esp32s3' },
      }),
    )
    const summary = await extractFirmwareZip(buildZip({ layout: newLayout, manifest }))

    expect(summary.errors.join('\n')).toContain('Bootloader targets 0x1000')
  })

  it('resolves build-relative manifest paths against a flattened CI zip', async () => {
    const summary = await extractFirmwareZip(
      buildZip({ layout: newLayout, manifest: manifestFor(0xf000, 0x20000) }),
    )
    // The manifest says "bootloader/bootloader.bin"; the zip has it at the root.
    expect(summary.entries.find((entry) => entry.role === 'bootloader')?.zipPath).toBe(
      'bootloader.bin',
    )
  })

  it('labels each file with the partition it lands in', async () => {
    const summary = await extractFirmwareZip(
      buildZip({ layout: newLayout, manifest: manifestFor(0xf000, 0x20000) }),
    )
    const app = summary.entries.find((entry) => entry.role === 'app')
    expect(app?.partitionLabel).toBe('factory')
    expect(summary.entries.find((entry) => entry.role === 'ota_data')?.partitionLabel).toBe(
      'otadata',
    )
  })

  it('flags an app image larger than its partition', async () => {
    const tiny: PartitionSpec[] = newLayout.map((part) =>
      part.label === 'factory' ? { ...part, size: 0x400 } : part,
    )
    const summary = await extractFirmwareZip(
      buildZip({ layout: tiny, manifest: manifestFor(0xf000, 0x20000) }),
    )
    expect(summary.errors.join('\n')).toMatch(/partition "factory" is only/)
  })

  it('reports .bin files the flash map does not cover instead of guessing', async () => {
    const summary = await extractFirmwareZip(
      buildZip({
        layout: newLayout,
        manifest: manifestFor(0xf000, 0x20000),
        extra: { 'storage.bin': new Uint8Array(64).fill(0x11) },
      }),
    )
    expect(summary.errors).toEqual([])
    expect(summary.unassignedBins.map((entry) => entry.path)).toEqual(['storage.bin'])
  })

  it('falls back to caller-supplied addresses only when the zip carries no flash map', async () => {
    const zipped = zipSync({
      'bootloader.bin': buildEspImage(ESP32S3, 0x2000),
      'ota_data_initial.bin': new Uint8Array(0x2000).fill(0xff),
      'mmwave_radar2_idf.bin': buildEspImage(ESP32S3, 0x1000),
    })
    const summary = await extractFirmwareZip(
      new File([zipped], 'legacy.zip', { type: 'application/zip' }),
      {
        defaultLayout: new Map([
          [0x0, 'bootloader.bin'],
          [0xd000, 'ota_data_initial.bin'],
          [0x10000, 'mmwave_radar2_idf.bin'],
        ]),
      },
    )

    expect(summary.layoutSource).toBe('defaults')
    expect(addressOf(summary, 'mmwave_radar2_idf.bin')).toBe(0x10000)
    expect(summary.warnings.join('\n')).toContain('built-in')
  })

  it('errors when nothing flashable can be resolved', async () => {
    const zipped = zipSync({ 'README.txt': new TextEncoder().encode('no binaries here') })
    const summary = await extractFirmwareZip(
      new File([zipped], 'empty.zip', { type: 'application/zip' }),
    )
    expect(summary.entries).toEqual([])
    expect(summary.errors.join('\n')).toContain('No flashable files')
  })
})
