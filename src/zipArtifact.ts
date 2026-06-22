import { strFromU8, unzipSync } from 'fflate'

export type FirmwareZipSummary = {
  /** File map keyed by the address that should be flashed there. */
  filesByAddress: Map<number, File>
  /** Address->bytesize map for any matched files (display only). */
  sizesByAddress: Map<number, number>
  /** Per-address resolution method, for log/UI diagnostics. */
  resolutionByAddress: Map<number, 'manifest' | 'basename' | 'leftover-fallback'>
  /** Addresses that successfully matched a file inside the zip. */
  matchedAddresses: number[]
  /** Addresses that could not be resolved from the zip contents. */
  missingAddresses: number[]
  /**
   * True when a `flasher_args.json` manifest was used to resolve files. False
   * means we fell back to filename-basename matching.
   */
  usedManifest: boolean
  /** Flash params parsed from `flasher_args.json` (informational only). */
  manifestParams?: { mode?: string; size?: string; freq?: string; chip?: string }
  /** Every `.bin` file we saw in the zip, with size (helps diagnose mismatches). */
  binFilesInZip: Array<{ path: string; size: number }>
  warnings: string[]
}

type ZipFiles = Record<string, Uint8Array>

const baseName = (path: string): string => {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

const formatHexAddress = (address: number): string =>
  `0x${address.toString(16)}`

const readZipFiles = async (file: File): Promise<ZipFiles> => {
  const buffer = await file.arrayBuffer()
  // Skip large debug artifacts (.elf is ~10 MB, .map ~8 MB) that we never flash.
  // This keeps the in-browser unzip fast and memory-light.
  return unzipSync(new Uint8Array(buffer), {
    filter: (info) => {
      if (info.size === 0) {
        // Keep manifest-like zero-byte files? Practically never useful.
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

type ManifestData = {
  flashFiles: Record<string, string>
  flashParams: FirmwareZipSummary['manifestParams']
}

const tryParseManifest = (files: ZipFiles, warnings: string[]): ManifestData | null => {
  const manifestEntry = Object.entries(files).find(
    ([path]) => baseName(path).toLowerCase() === 'flasher_args.json',
  )
  if (!manifestEntry) {
    return null
  }
  try {
    const text = strFromU8(manifestEntry[1])
    const parsed = JSON.parse(text) as {
      flash_files?: Record<string, string>
      flash_settings?: { flash_mode?: string; flash_size?: string; flash_freq?: string }
      extra_esptool_args?: { chip?: string }
    }
    if (!parsed.flash_files || typeof parsed.flash_files !== 'object') {
      warnings.push('flasher_args.json had no flash_files map; falling back to filename matching.')
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

const normalizeAddressKey = (raw: string): number | null => {
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
 * Resolve a manifest path inside the zip. Manifest paths can be relative
 * with subdirectories (e.g. "bootloader/bootloader.bin"). We try exact path
 * first, then normalized variants, and finally fall back to basename match.
 */
const resolvePathInZip = (
  files: ZipFiles,
  basenameIndex: Map<string, string>,
  path: string,
): { fullPath: string; bytes: Uint8Array } | null => {
  if (files[path]) {
    return { fullPath: path, bytes: files[path] }
  }
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (files[normalized]) {
    return { fullPath: normalized, bytes: files[normalized] }
  }
  const base = baseName(path).toLowerCase()
  const indexed = basenameIndex.get(base)
  if (indexed) {
    return { fullPath: indexed, bytes: files[indexed] }
  }
  return null
}

/**
 * Open a firmware ZIP (typically produced by a GitHub Actions CI build) and
 * resolve each expected flash address to a `File` ready for esptool-js.
 *
 * Resolution order:
 *   1. If `flasher_args.json` is inside the zip, use its `flash_files` map.
 *   2. Otherwise match each address to a basename from `expectedBasenames`.
 *
 * Address-to-file pairing is intentionally driven by the caller (the Flash
 * tab pins addresses to 0x0/0x8000/0xd000/0x10000) — the manifest only
 * supplies file *names*, never new addresses.
 */
export type ExtractFirmwareZipOptions = {
  /**
   * If exactly one address is unresolved AND exactly one `.bin` in the zip
   * remains unclaimed, we *may* assign that file to a missing address — but
   * only if it matches `address`. This is meant strictly for the app slot
   * (e.g. 0x10000) when CI renamed the app binary and didn't ship a manifest.
   *
   * Without this guard, a zip missing `bootloader.bin` but containing some
   * other extra binary (e.g. `phy_init_data.bin`) would silently flash that
   * to `0x0` and brick the device.
   */
  leftoverFallback?: { address: number }
}

export const extractFirmwareZip = async (
  zip: File,
  expectedBasenames: Map<number, string>,
  options: ExtractFirmwareZipOptions = {},
): Promise<FirmwareZipSummary> => {
  const warnings: string[] = []
  const files = await readZipFiles(zip)

  // Build a "shortest path" basename index so manifests with prefixed dirs
  // like "bootloader/bootloader.bin" still resolve against flat zips, and
  // wrapped zips like "gm_radar-wifi-1/bootloader.bin" resolve too.
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

  const manifest = tryParseManifest(files, warnings)
  const filesByAddress = new Map<number, File>()
  const sizesByAddress = new Map<number, number>()
  const resolutionByAddress = new Map<number, 'manifest' | 'basename' | 'leftover-fallback'>()
  const usedZipPaths = new Set<string>()
  const expectedAddresses = Array.from(expectedBasenames.keys())

  // Snapshot every .bin file in the zip up-front — useful both for diagnostics
  // and the "single leftover .bin = app" smart fallback below.
  const binFilesInZip: Array<{ path: string; size: number }> = []
  for (const [path, bytes] of Object.entries(files)) {
    if (path.endsWith('/')) {
      continue
    }
    if (baseName(path).toLowerCase().endsWith('.bin')) {
      binFilesInZip.push({ path, size: bytes.byteLength })
    }
  }

  const claimMatch = (
    address: number,
    matched: { fullPath: string; bytes: Uint8Array },
    method: 'manifest' | 'basename' | 'leftover-fallback',
  ) => {
    const copy = new Uint8Array(matched.bytes)
    const fileName = baseName(matched.fullPath)
    const fileObj = new File([copy], fileName, { type: 'application/octet-stream' })
    filesByAddress.set(address, fileObj)
    sizesByAddress.set(address, copy.byteLength)
    resolutionByAddress.set(address, method)
    usedZipPaths.add(matched.fullPath)
  }

  for (const address of expectedAddresses) {
    let matched: { fullPath: string; bytes: Uint8Array } | null = null
    let method: 'manifest' | 'basename' = 'basename'

    if (manifest) {
      // Manifest keys are hex strings; normalize and match by numeric value.
      const manifestEntry = Object.entries(manifest.flashFiles).find(([key]) => {
        const numericKey = normalizeAddressKey(key)
        return numericKey === address
      })
      if (manifestEntry) {
        matched = resolvePathInZip(files, basenameIndex, manifestEntry[1])
        if (matched) {
          method = 'manifest'
        } else {
          warnings.push(
            `Manifest mapped ${formatHexAddress(address)} -> ${manifestEntry[1]} but the file is not in the zip.`,
          )
        }
      }
    }

    if (!matched) {
      const expectedBase = expectedBasenames.get(address)
      if (expectedBase) {
        const indexed = basenameIndex.get(expectedBase.toLowerCase())
        if (indexed) {
          matched = { fullPath: indexed, bytes: files[indexed] }
          method = 'basename'
        }
      }
    }

    if (matched) {
      claimMatch(address, matched, method)
    }
  }

  // Smart fallback (strictly opt-in by caller): if exactly one address is still
  // missing AND there's exactly one unclaimed .bin in the zip AND that missing
  // address is the caller-whitelisted one (intended for the app slot, e.g.
  // 0x10000), assume the leftover .bin is the renamed app firmware. We refuse
  // to guess when:
  //   - more than one address is missing,
  //   - more than one .bin is unclaimed, or
  //   - the missing address is not the caller-whitelisted address.
  // This avoids the disaster case of mapping a random extra .bin to a critical
  // address like 0x0 (bootloader).
  const missingForFallback = expectedAddresses.filter((addr) => !filesByAddress.has(addr))
  const fallbackAddress = options.leftoverFallback?.address
  if (
    fallbackAddress !== undefined &&
    missingForFallback.length === 1 &&
    missingForFallback[0] === fallbackAddress
  ) {
    const unclaimedBins = binFilesInZip.filter((entry) => !usedZipPaths.has(entry.path))
    if (unclaimedBins.length === 1) {
      const onlyEntry = unclaimedBins[0]
      const bytes = files[onlyEntry.path]
      claimMatch(fallbackAddress, { fullPath: onlyEntry.path, bytes }, 'leftover-fallback')
      warnings.push(
        `Used "${baseName(onlyEntry.path)}" as the file for ${formatHexAddress(fallbackAddress)} ` +
          `(no manifest entry and the expected name "${expectedBasenames.get(fallbackAddress)}" was not in the zip).`,
      )
    }
  }

  const matchedAddresses = expectedAddresses.filter((addr) => filesByAddress.has(addr))
  const missingAddresses = expectedAddresses.filter((addr) => !filesByAddress.has(addr))

  return {
    filesByAddress,
    sizesByAddress,
    resolutionByAddress,
    matchedAddresses,
    missingAddresses,
    usedManifest: Boolean(manifest),
    manifestParams: manifest?.flashParams,
    binFilesInZip,
    warnings,
  }
}
