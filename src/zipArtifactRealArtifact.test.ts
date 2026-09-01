import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractFirmwareZip, parsePartitionTable } from './zipArtifact'

/**
 * Exercises the extractor against real ESP-IDF output rather than fixtures.
 * A hand-rolled partition table is easy to get subtly wrong (the entry magic
 * is byte-order sensitive), so these run whenever the gm_radar repo is checked
 * out next to webuart, and skip otherwise.
 */
const radarRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../gm_radar')
const variants = ['firmware', 'eth_firmware'].filter((dir) =>
  existsSync(resolve(radarRoot, dir, 'bin/partition-table.bin')),
)

const read = (relative: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(radarRoot, relative)))

/** Mirrors what the CI workflow uploads: build outputs flattened into one dir. */
const buildArtifactZip = (dir: string, manifest?: string): File => {
  const files: Record<string, Uint8Array> = {
    'bootloader.bin': read(`${dir}/bin/bootloader.bin`),
    'partition-table.bin': read(`${dir}/bin/partition-table.bin`),
    'ota_data_initial.bin': read(`${dir}/bin/ota_data_initial.bin`),
    'mmwave_radar2_idf.bin': read(`${dir}/bin/mmwave_radar2_idf.bin`),
  }
  if (manifest) {
    files['flasher_args.json'] = new TextEncoder().encode(manifest)
  }
  return new File([zipSync(files)], `gm_radar-${dir}.zip`, { type: 'application/zip' })
}

describe.skipIf(variants.length === 0)('extractFirmwareZip against real gm_radar builds', () => {
  it('parses an ESP-IDF-generated partition table', () => {
    const parsed = parsePartitionTable(read(`${variants[0]}/bin/partition-table.bin`))
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed.map((entry) => entry.label)).toContain('otadata')
    expect(parsed.some((entry) => entry.type === 0x00)).toBe(true)
  })

  it.each(variants)(
    'derives %s addresses from the partition table shipped beside it',
    async (dir) => {
      const summary = await extractFirmwareZip(buildArtifactZip(dir))
      const table = parsePartitionTable(read(`${dir}/bin/partition-table.bin`))
      const byName = Object.fromEntries(
        summary.entries.map((entry) => [entry.name, entry.address]),
      )

      expect(summary.errors).toEqual([])
      expect(summary.layoutSource).toBe('partition-table')
      expect(summary.chipName).toBe('esp32s3')
      expect(summary.flashParams).toMatchObject({ mode: 'dio', size: '8MB', freq: '80m' })

      expect(byName['bootloader.bin']).toBe(0x0)
      expect(byName['partition-table.bin']).toBe(0x8000)
      // Derived, not assumed: whatever this build's own table declares.
      expect(byName['ota_data_initial.bin']).toBe(
        table.find((entry) => entry.label === 'otadata')?.offset,
      )
      expect(byName['mmwave_radar2_idf.bin']).toBe(
        table.find((entry) => entry.label === 'factory')?.offset,
      )
    },
  )

  it('refuses a flash map that disagrees with the bundled partition table', async () => {
    // A manifest for the post-move layout (otadata 0xf000, app 0x20000) paired
    // with binaries built for the older one.
    const manifest = JSON.stringify({
      flash_settings: { flash_mode: 'dio', flash_size: '8MB', flash_freq: '80m' },
      flash_files: {
        '0x0': 'bootloader/bootloader.bin',
        '0x8000': 'partition_table/partition-table.bin',
        '0xf000': 'ota_data_initial.bin',
        '0x20000': 'mmwave_radar2_idf.bin',
      },
      extra_esptool_args: { chip: 'esp32s3' },
    })
    const summary = await extractFirmwareZip(buildArtifactZip(variants[0], manifest))
    const table = parsePartitionTable(read(`${variants[0]}/bin/partition-table.bin`))
    const otaOffset = table.find((entry) => entry.label === 'otadata')?.offset ?? 0

    if (otaOffset === 0xf000) {
      // Binaries already rebuilt for the new layout — nothing to disagree with.
      expect(summary.errors).toEqual([])
      return
    }
    expect(summary.errors.length).toBeGreaterThan(0)
    expect(summary.errors.join('\n')).toContain('otadata partition is at')
  })
})
