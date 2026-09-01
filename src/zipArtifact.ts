import { strFromU8, unzipSync } from 'fflate'

/**
 * Firmware ZIP -> flash plan.
 *
 * IMPORTANT: addresses are *derived from the artifact*, never hardcoded.
 * gm_radar's partition table moved otadata 0xd000 -> 0xf000 and the app
 * 0x10000 -> 0x20000; anything that pins addresses in the UI silently writes
 * the app into a gap (boot loop) and ota_data into nvs (NVS corruption).
 *
 * Resolution order, most authoritative first:
 *   1. `flasher_args.json` — ESP-IDF's own flash map (address AND file).
 *   2. `partition-table.bin` — parsed; otadata/app offsets read straight from
 *      the table that is about to be flashed, so a manifest-less zip still
 *      lands correctly.
 *   3. `defaultLayout` supplied by the caller — last resort only.
 */

export type FlashRole = 'bootloader' | 'partitions' | 'ota_data' | 'app' | 'other'

export type LayoutSource = 'manifest' | 'partition-table' | 'defaults'

export type FirmwareFileEntry = {
  address: number
  file: File
  /** Basename as it will be shown in the UI / passed to esptool. */
  name: string
  /** Full path inside the zip (may include CI directory prefixes). */
  zipPath: string
  size: number
  role: FlashRole
  /** Partition this address falls into, when a partition table was parsed. */
  partitionLabel?: string
}

export type PartitionEntry = {
  label: string
  type: number
  subType: number
  offset: number
  size: number
}

export type FirmwareFlashParams = {
  mode?: string
  size?: string
  freq?: string
  chip?: string
}

export type FirmwareZipSummary = {
  /** The flash plan, sorted by address. Empty when nothing could be resolved. */
  entries: FirmwareFileEntry[]
  /** How the addresses in `entries` were determined. */
  layoutSource: LayoutSource
  /** Parsed from `partition-table.bin`, when present in the zip. */
  partitions: PartitionEntry[] | null
  /** Chip id read from the app/bootloader image header (ESP-IDF >= v4.0). */
  chipId: number | null
  /** Human-readable chip name for `chipId`, e.g. "esp32s3". */
  chipName: string | null
  /** Flash mode/size/freq, from the manifest or the app image header. */
  flashParams: FirmwareFlashParams
  /** Every `.bin` in the zip, for diagnostics. */
  binFilesInZip: Array<{ path: string; size: number }>
  /** `.bin` files present in the zip that the plan does not flash. */
  unassignedBins: Array<{ path: string; size: number }>
  /** Non-fatal observations worth logging. */
  warnings: string[]
  /**
   * Blocking problems. A non-empty `errors` means the plan must NOT be
   * flashed — every one of these would brick or half-brick the board.
   */
  errors: string[]
}

export type ExtractFirmwareZipOptions = {
  /**
   * Address -> expected basename, used only when the zip carries neither a
   * manifest nor a partition table. Deliberately last-resort: a stale default
   * is exactly what this module exists to stop relying on.
   */
  defaultLayout?: Map<number, string>
}

type ZipFiles = Record<string, Uint8Array>

const IMAGE_MAGIC = 0xe9
/** Entry magic, stored as bytes AA 50 -> 0x50AA when read little-endian. */
const PARTITION_MAGIC = 0x50aa
const PARTITION_ENTRY_SIZE = 32
const PARTITION_TABLE_DEFAULT_OFFSET = 0x8000

const PARTITION_TYPE_APP = 0x00
const PARTITION_TYPE_DATA = 0x01
const PARTITION_SUBTYPE_APP_FACTORY = 0x00
const PARTITION_SUBTYPE_DATA_OTA = 0x00

const isOtaAppSubtype = (subType: number): boolean => subType >= 0x10 && subType <= 0x1f

/** Chip id -> name, as encoded in the ESP image header (bytes 12..13). */
const CHIP_IDS: Record<number, string> = {
  0x0000: 'esp32',
  0x0002: 'esp32s2',
  0x0005: 'esp32c3',
  0x0009: 'esp32s3',
  0x000c: 'esp32c2',
  0x000d: 'esp32c6',
  0x0010: 'esp32h2',
  0x0012: 'esp32p4',
}

/**
 * Where the 2nd-stage bootloader lives, per chip. ESP32/S2 keep 0x1000 for the
 * legacy 4 KB gap; the newer parts start at 0x0.
 */
const BOOTLOADER_OFFSETS: Record<string, number> = {
  esp32: 0x1000,
  esp32s2: 0x1000,
  esp32p4: 0x2000,
  esp32s3: 0x0,
  esp32c2: 0x0,
  esp32c3: 0x0,
  esp32c6: 0x0,
  esp32h2: 0x0,
}

const FLASH_SIZE_BY_NIBBLE: Record<number, string> = {
  0x0: '1MB',
  0x1: '2MB',
  0x2: '4MB',
  0x3: '8MB',
  0x4: '16MB',
  0x5: '32MB',
  0x6: '64MB',
  0x7: '128MB',
}

const FLASH_FREQ_BY_NIBBLE: Record<number, string> = {
  0x0: '40m',
  0x1: '26m',
  0x2: '20m',
  0xf: '80m',
}

const FLASH_MODE_BY_BYTE: Record<number, string> = {
  0: 'qio',
  1: 'qout',
  2: 'dio',
  3: 'dout',
}

export const baseName = (path: string): string => {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

export const formatHexAddress = (address: number): string => `0x${address.toString(16)}`

const readZipFiles = async (file: File): Promise<ZipFiles> => {
  const buffer = await file.arrayBuffer()
  // Skip large debug artifacts (.elf is ~10 MB, .map ~8 MB) that we never flash.
  // This keeps the in-browser unzip fast and memory-light.
  return unzipSync(new Uint8Array(buffer), {
    filter: (info) => {
      if (info.size === 0) {
        return false
      }
      const name = baseName(info.name).toLowerCase()
      if (name.endsWith('.elf') || name.endsWith('.map')) {
        return false
      }
      // Sanity cap: refuse single entries larger than 32 MB inside the artifact.
      return info.size < 32 * 1024 * 1024
    },
  })
}

/* ------------------------------------------------------------------ */
/* Partition table                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse an ESP-IDF partition table image. Each record is 32 bytes:
 *   u16 magic (0x50AA LE) | u8 type | u8 subtype | u32 offset | u32 size
 *   | char[16] label | u32 flags
 * The table ends at the first record without the magic (usually the MD5
 * checksum record, magic 0xEBEB).
 */
export const parsePartitionTable = (bytes: Uint8Array): PartitionEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: PartitionEntry[] = []
  for (let cursor = 0; cursor + PARTITION_ENTRY_SIZE <= bytes.byteLength; cursor += PARTITION_ENTRY_SIZE) {
    if (view.getUint16(cursor, true) !== PARTITION_MAGIC) {
      break
    }
    // The 16-byte label is padded with NULs by ESP-IDF, but 0xFF shows up in
    // tables carved out of an erased-flash dump — stop at either.
    const labelBytes = bytes.subarray(cursor + 12, cursor + 28)
    let labelEnd = labelBytes.length
    for (let index = 0; index < labelBytes.length; index += 1) {
      if (labelBytes[index] === 0x00 || labelBytes[index] === 0xff) {
        labelEnd = index
        break
      }
    }
    const label = new TextDecoder().decode(labelBytes.subarray(0, labelEnd)).trim()
    entries.push({
      label,
      type: view.getUint8(cursor + 2),
      subType: view.getUint8(cursor + 3),
      offset: view.getUint32(cursor + 4, true),
      size: view.getUint32(cursor + 8, true),
    })
  }
  return entries
}

const findOtaDataPartition = (partitions: PartitionEntry[]): PartitionEntry | undefined =>
  partitions.find(
    (entry) => entry.type === PARTITION_TYPE_DATA && entry.subType === PARTITION_SUBTYPE_DATA_OTA,
  )

/**
 * The slot a freshly flashed app belongs in: `factory` when the table has one,
 * otherwise the first OTA slot — mirroring what `idf.py flash` does.
 */
const findPrimaryAppPartition = (partitions: PartitionEntry[]): PartitionEntry | undefined => {
  const appPartitions = partitions.filter((entry) => entry.type === PARTITION_TYPE_APP)
  return (
    appPartitions.find((entry) => entry.subType === PARTITION_SUBTYPE_APP_FACTORY) ??
    appPartitions
      .filter((entry) => isOtaAppSubtype(entry.subType))
      .sort((a, b) => a.subType - b.subType)[0]
  )
}

const partitionContaining = (
  partitions: PartitionEntry[] | null,
  address: number,
): PartitionEntry | undefined =>
  partitions?.find((entry) => address >= entry.offset && address < entry.offset + entry.size)

/* ------------------------------------------------------------------ */
/* Image headers                                                       */
/* ------------------------------------------------------------------ */

type ImageHeader = {
  chipId: number
  flashMode?: string
  flashSize?: string
  flashFreq?: string
}

/**
 * Read the 24-byte ESP image header: magic, segment count, flash mode,
 * packed size/freq nibbles, entry point, and (v4.0+) the chip id at 12..13.
 */
export const readImageHeader = (bytes: Uint8Array): ImageHeader | null => {
  if (bytes.byteLength < 24 || bytes[0] !== IMAGE_MAGIC) {
    return null
  }
  const sizeFreq = bytes[3]
  return {
    chipId: bytes[12] | (bytes[13] << 8),
    flashMode: FLASH_MODE_BY_BYTE[bytes[2]],
    flashSize: FLASH_SIZE_BY_NIBBLE[(sizeFreq >> 4) & 0x0f],
    flashFreq: FLASH_FREQ_BY_NIBBLE[sizeFreq & 0x0f],
  }
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

type ManifestData = {
  flashFiles: Record<string, string>
  flashParams: FirmwareFlashParams
}

const tryParseManifest = (files: ZipFiles, warnings: string[]): ManifestData | null => {
  const manifestEntry = Object.entries(files).find(
    ([path]) => baseName(path).toLowerCase() === 'flasher_args.json',
  )
  if (!manifestEntry) {
    return null
  }
  try {
    const parsed = JSON.parse(strFromU8(manifestEntry[1])) as {
      flash_files?: Record<string, string>
      flash_settings?: { flash_mode?: string; flash_size?: string; flash_freq?: string }
      extra_esptool_args?: { chip?: string }
    }
    if (!parsed.flash_files || typeof parsed.flash_files !== 'object') {
      warnings.push('flasher_args.json had no flash_files map; falling back to the partition table.')
      return null
    }
    return {
      flashFiles: parsed.flash_files,
      flashParams: {
        mode: parsed.flash_settings?.flash_mode,
        size: parsed.flash_settings?.flash_size,
        freq: parsed.flash_settings?.flash_freq,
        chip: parsed.extra_esptool_args?.chip,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'parse error'
    warnings.push(`Failed to parse flasher_args.json: ${message}`)
    return null
  }
}

export const normalizeAddressKey = (raw: string): number | null => {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) {
    return null
  }
  const value = trimmed.startsWith('0x')
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 16)
  return Number.isFinite(value) ? value : null
}

/**
 * Resolve a manifest path inside the zip. Manifest paths are build-relative
 * with subdirectories (`bootloader/bootloader.bin`), while CI usually flattens
 * the artifact — so fall back to a basename lookup.
 */
const resolvePathInZip = (
  files: ZipFiles,
  basenameIndex: Map<string, string>,
  path: string,
): { zipPath: string; bytes: Uint8Array } | null => {
  const direct = files[path]
  if (direct) {
    return { zipPath: path, bytes: direct }
  }
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const viaNormalized = files[normalized]
  if (viaNormalized) {
    return { zipPath: normalized, bytes: viaNormalized }
  }
  const indexed = basenameIndex.get(baseName(path).toLowerCase())
  if (indexed) {
    return { zipPath: indexed, bytes: files[indexed] }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Role inference                                                      */
/* ------------------------------------------------------------------ */

const roleFromName = (name: string): FlashRole | null => {
  const lower = baseName(name).toLowerCase()
  if (lower === 'bootloader.bin') {
    return 'bootloader'
  }
  if (lower.includes('partition') && lower.endsWith('.bin')) {
    return 'partitions'
  }
  if (lower.includes('ota_data') || lower === 'otadata.bin') {
    return 'ota_data'
  }
  return null
}

const inferRole = (
  name: string,
  bytes: Uint8Array,
  address: number,
  partitions: PartitionEntry[] | null,
): FlashRole => {
  const byName = roleFromName(name)
  if (byName) {
    return byName
  }
  // Classify by content before consulting the partition table: when the plan's
  // addresses are wrong (the bug this module guards against) the address lands
  // in an unrelated partition, and trusting that would mislabel the app as
  // whatever it happens to overlap and skip the app-placement check.
  if (bytes[0] === IMAGE_MAGIC) {
    return address < PARTITION_TABLE_DEFAULT_OFFSET ? 'bootloader' : 'app'
  }
  const containing = partitionContaining(partitions, address)
  if (containing) {
    if (containing.type === PARTITION_TYPE_APP) {
      return 'app'
    }
    if (
      containing.type === PARTITION_TYPE_DATA &&
      containing.subType === PARTITION_SUBTYPE_DATA_OTA
    ) {
      return 'ota_data'
    }
  }
  return 'other'
}

/* ------------------------------------------------------------------ */
/* Layout building                                                     */
/* ------------------------------------------------------------------ */

type ResolvedFile = { zipPath: string; bytes: Uint8Array }

type PlannedFile = { address: number; resolved: ResolvedFile }

const buildManifestLayout = (
  manifest: ManifestData,
  files: ZipFiles,
  basenameIndex: Map<string, string>,
  warnings: string[],
): PlannedFile[] => {
  const planned: PlannedFile[] = []
  for (const [rawAddress, path] of Object.entries(manifest.flashFiles)) {
    const address = normalizeAddressKey(rawAddress)
    if (address === null) {
      warnings.push(`Ignoring unparseable manifest address "${rawAddress}".`)
      continue
    }
    const resolved = resolvePathInZip(files, basenameIndex, path)
    if (!resolved) {
      warnings.push(
        `Manifest maps ${formatHexAddress(address)} -> ${path} but that file is not in the zip.`,
      )
      continue
    }
    planned.push({ address, resolved })
  }
  return planned
}

/**
 * Derive the layout from the partition table image itself. The table about to
 * be flashed is the same one the bootloader will read, so its otadata and app
 * offsets are correct by construction — this is what keeps the Flash tab
 * working across firmware layout changes.
 */
const buildPartitionTableLayout = (
  partitions: PartitionEntry[],
  candidates: Map<FlashRole, ResolvedFile>,
  chipName: string | null,
  partitionTableOffset: number,
  warnings: string[],
): PlannedFile[] => {
  const planned: PlannedFile[] = []

  const bootloader = candidates.get('bootloader')
  if (bootloader) {
    const offset = chipName ? BOOTLOADER_OFFSETS[chipName] : undefined
    if (offset === undefined) {
      warnings.push(
        `Unknown chip for bootloader offset; assuming 0x0. Verify before flashing.`,
      )
    }
    planned.push({ address: offset ?? 0x0, resolved: bootloader })
  }

  const partitionsFile = candidates.get('partitions')
  if (partitionsFile) {
    planned.push({ address: partitionTableOffset, resolved: partitionsFile })
  }

  const otaData = candidates.get('ota_data')
  if (otaData) {
    const otaPartition = findOtaDataPartition(partitions)
    if (otaPartition) {
      planned.push({ address: otaPartition.offset, resolved: otaData })
    } else {
      warnings.push(
        'Zip contains ota_data_initial.bin but the partition table has no otadata partition; skipping it.',
      )
    }
  }

  const app = candidates.get('app')
  if (app) {
    const appPartition = findPrimaryAppPartition(partitions)
    if (appPartition) {
      planned.push({ address: appPartition.offset, resolved: app })
    } else {
      warnings.push('Partition table declares no app partition; cannot place the application binary.')
    }
  }

  return planned
}

const buildDefaultLayout = (
  defaultLayout: Map<number, string>,
  basenameIndex: Map<string, string>,
  files: ZipFiles,
): PlannedFile[] => {
  const planned: PlannedFile[] = []
  for (const [address, expectedName] of defaultLayout) {
    const zipPath = basenameIndex.get(expectedName.toLowerCase())
    if (zipPath) {
      planned.push({ address, resolved: { zipPath, bytes: files[zipPath] } })
    }
  }
  return planned
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Catch the failure mode that motivated this module: a plan whose addresses
 * disagree with the partition table it is flashing. Every check here maps to a
 * real way to brick the board, so they are errors, not warnings.
 */
const validatePlan = (
  entries: FirmwareFileEntry[],
  partitions: PartitionEntry[] | null,
  errors: string[],
  warnings: string[],
): void => {
  // Overlapping writes — a later file would silently truncate an earlier one.
  const sorted = [...entries].sort((a, b) => a.address - b.address)
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    const current = sorted[index]
    const previousEnd = previous.address + previous.size
    if (previousEnd > current.address) {
      errors.push(
        `${previous.name} at ${formatHexAddress(previous.address)} (${previous.size} B) overlaps ` +
          `${current.name} at ${formatHexAddress(current.address)}.`,
      )
    }
  }

  if (!partitions) {
    return
  }

  for (const entry of entries) {
    if (entry.role === 'bootloader' || entry.role === 'partitions') {
      // Both live below the partition table, outside its address space.
      continue
    }
    const containing = partitionContaining(partitions, entry.address)
    if (!containing) {
      errors.push(
        `${entry.name} targets ${formatHexAddress(entry.address)}, which is not inside any ` +
          `partition in this build's partition table. Flashing it would leave the device unbootable.`,
      )
      continue
    }
    if (containing.offset !== entry.address) {
      errors.push(
        `${entry.name} targets ${formatHexAddress(entry.address)}, which is inside partition ` +
          `"${containing.label}" but not at its start (${formatHexAddress(containing.offset)}).`,
      )
      continue
    }
    if (entry.size > containing.size) {
      errors.push(
        `${entry.name} is ${entry.size} B but partition "${containing.label}" is only ` +
          `${containing.size} B.`,
      )
    }
  }

  const otaPartition = findOtaDataPartition(partitions)
  const otaEntry = entries.find((entry) => entry.role === 'ota_data')
  if (otaEntry && otaPartition && otaEntry.address !== otaPartition.offset) {
    errors.push(
      `ota_data targets ${formatHexAddress(otaEntry.address)} but this build's otadata ` +
        `partition is at ${formatHexAddress(otaPartition.offset)}.`,
    )
  }

  const appPartition = findPrimaryAppPartition(partitions)
  const appEntry = entries.find((entry) => entry.role === 'app')
  if (appEntry && appPartition && appEntry.address !== appPartition.offset) {
    errors.push(
      `Application targets ${formatHexAddress(appEntry.address)} but this build's ` +
        `"${appPartition.label}" partition starts at ${formatHexAddress(appPartition.offset)}.`,
    )
  }
  if (appEntry && !appPartition) {
    warnings.push('No app partition found in the partition table; app placement is unverified.')
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export const extractFirmwareZip = async (
  zip: File,
  options: ExtractFirmwareZipOptions = {},
): Promise<FirmwareZipSummary> => {
  const warnings: string[] = []
  const errors: string[] = []
  const files = await readZipFiles(zip)

  // "Shortest path wins" basename index, so manifests with build-relative dirs
  // (`bootloader/bootloader.bin`) resolve against flat CI zips, and wrapped
  // zips (`gm_radar-wifi-1/bootloader.bin`) resolve too.
  const basenameIndex = new Map<string, string>()
  for (const path of Object.keys(files)) {
    if (path.endsWith('/')) {
      continue
    }
    const lower = baseName(path).toLowerCase()
    const existing = basenameIndex.get(lower)
    if (!existing || path.length < existing.length) {
      basenameIndex.set(lower, path)
    }
  }

  const binFilesInZip: Array<{ path: string; size: number }> = []
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.endsWith('/') && baseName(path).toLowerCase().endsWith('.bin')) {
      binFilesInZip.push({ path, size: bytes.byteLength })
    }
  }

  // Classify the .bin files by name/magic up-front. Used to build a layout
  // when there is no manifest, and to spot the app image header.
  const candidates = new Map<FlashRole, ResolvedFile>()
  const appLike: ResolvedFile[] = []
  for (const { path } of binFilesInZip) {
    const bytes = files[path]
    const named = roleFromName(path)
    if (named) {
      if (!candidates.has(named)) {
        candidates.set(named, { zipPath: path, bytes })
      }
      continue
    }
    if (bytes[0] === IMAGE_MAGIC) {
      appLike.push({ zipPath: path, bytes })
    }
  }
  if (appLike.length === 1) {
    candidates.set('app', appLike[0])
  } else if (appLike.length > 1) {
    warnings.push(
      `Zip contains ${appLike.length} application-like images ` +
        `(${appLike.map((entry) => baseName(entry.zipPath)).join(', ')}); ` +
        'relying on flasher_args.json to pick the right one.',
    )
  }

  const partitionsCandidate = candidates.get('partitions')
  let partitions: PartitionEntry[] | null = null
  if (partitionsCandidate) {
    const parsed = parsePartitionTable(partitionsCandidate.bytes)
    if (parsed.length > 0) {
      partitions = parsed
    } else {
      warnings.push(
        `${baseName(partitionsCandidate.zipPath)} does not look like a partition table ` +
          '(bad magic); address checks are disabled.',
      )
    }
  }

  const appHeader = candidates.get('app')
    ? readImageHeader(candidates.get('app')!.bytes)
    : null
  const bootloaderHeader = candidates.get('bootloader')
    ? readImageHeader(candidates.get('bootloader')!.bytes)
    : null
  const header = appHeader ?? bootloaderHeader
  const chipId = header?.chipId ?? null
  const chipName = chipId !== null ? (CHIP_IDS[chipId] ?? null) : null

  const manifest = tryParseManifest(files, warnings)

  // Prefer the manifest's own partition-table offset over the 0x8000 default.
  let partitionTableOffset = PARTITION_TABLE_DEFAULT_OFFSET
  if (manifest) {
    for (const [rawAddress, path] of Object.entries(manifest.flashFiles)) {
      if (roleFromName(path) === 'partitions') {
        const parsedAddress = normalizeAddressKey(rawAddress)
        if (parsedAddress !== null) {
          partitionTableOffset = parsedAddress
        }
      }
    }
  }

  let layoutSource: LayoutSource
  let planned: PlannedFile[]
  if (manifest) {
    layoutSource = 'manifest'
    planned = buildManifestLayout(manifest, files, basenameIndex, warnings)
  } else if (partitions) {
    layoutSource = 'partition-table'
    planned = buildPartitionTableLayout(
      partitions,
      candidates,
      chipName,
      partitionTableOffset,
      warnings,
    )
    warnings.push(
      'No flasher_args.json in the zip; addresses were derived from partition-table.bin.',
    )
  } else {
    layoutSource = 'defaults'
    planned = options.defaultLayout
      ? buildDefaultLayout(options.defaultLayout, basenameIndex, files)
      : []
    if (planned.length > 0) {
      warnings.push(
        'Zip has neither flasher_args.json nor partition-table.bin; falling back to built-in ' +
          'addresses, which may not match this firmware. Verify before flashing.',
      )
    }
  }

  const entries: FirmwareFileEntry[] = planned
    .map(({ address, resolved }) => {
      const bytes = new Uint8Array(resolved.bytes)
      const name = baseName(resolved.zipPath)
      return {
        address,
        file: new File([bytes], name, { type: 'application/octet-stream' }),
        name,
        zipPath: resolved.zipPath,
        size: bytes.byteLength,
        role: inferRole(name, bytes, address, partitions),
        partitionLabel: partitionContaining(partitions, address)?.label,
      }
    })
    .sort((a, b) => a.address - b.address)

  // A bootloader written to the wrong offset is an unrecoverable-looking brick
  // (recoverable only over the ROM loader), so check it explicitly.
  const bootloaderEntry = entries.find((entry) => entry.role === 'bootloader')
  if (bootloaderEntry && chipName) {
    const expected = BOOTLOADER_OFFSETS[chipName]
    if (expected !== undefined && bootloaderEntry.address !== expected) {
      errors.push(
        `Bootloader targets ${formatHexAddress(bootloaderEntry.address)} but ${chipName} expects ` +
          `${formatHexAddress(expected)}.`,
      )
    }
  }

  validatePlan(entries, partitions, errors, warnings)

  if (entries.length === 0) {
    errors.push('No flashable files could be resolved from this zip.')
  } else {
    for (const role of ['bootloader', 'partitions', 'app'] as const) {
      if (!entries.some((entry) => entry.role === role)) {
        warnings.push(`No ${role} image in this zip; it will not be written.`)
      }
    }
  }

  const plannedPaths = new Set(entries.map((entry) => entry.zipPath))
  const unassignedBins = binFilesInZip.filter((entry) => !plannedPaths.has(entry.path))

  const flashParams: FirmwareFlashParams = {
    mode: manifest?.flashParams.mode ?? header?.flashMode,
    size: manifest?.flashParams.size ?? header?.flashSize,
    freq: manifest?.flashParams.freq ?? header?.flashFreq,
    chip: manifest?.flashParams.chip ?? chipName ?? undefined,
  }

  return {
    entries,
    layoutSource,
    partitions,
    chipId,
    chipName,
    flashParams,
    binFilesInZip,
    unassignedBins,
    warnings,
    errors,
  }
}
