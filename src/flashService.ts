import { ESPLoader, Transport } from 'esptool-js'

export type FlashFile = {
  id: string
  file: File
  address: number
}

export type FlashChipInfo = {
  chipName: string
  chipFamily: string
  macAddress: string
}

export type FlashTerminal = {
  clean: () => void
  writeLine: (data: string) => void
  write: (data: string) => void
}

export type FlashSession = {
  port: SerialPort | null
  transport: Transport | null
  loader: ESPLoader | null
  chipInfo: FlashChipInfo | null
}

export type FlashChip =
  | 'auto'
  | 'esp32'
  | 'esp32s2'
  | 'esp32s3'
  | 'esp32c3'
  | 'esp32c6'
  | 'esp32h2'
  | 'esp8266'

/**
 * Reduce a chip string to a bare family token ("esp32s3") so a firmware's
 * target can be compared with the connected board.
 *
 * Handles every shape esptool-js and ESP-IDF produce: `CHIP_NAME` ("ESP32-S3"),
 * `getChipDescription()` ("ESP32-S3 (QFN56) (revision v0.2)", and the
 * "unknown ESP32-S3 (revision v0.0)" fallback for unrecognised packages), and
 * manifest fields ("esp32s3").
 *
 * Returns null when no family can be identified — callers must treat that as
 * "cannot tell" and skip the comparison rather than assume a mismatch.
 */
export const normalizeChipName = (raw: string): string | null => {
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  // Deliberately unanchored: descriptions may be prefixed ("unknown ESP32-S3").
  const match = compact.match(/esp(8266|32)(s2|s3|c2|c3|c5|c61|c6|h2|p4)?/)
  if (!match) {
    return null
  }
  return `esp${match[1]}${match[2] ?? ''}`
}

export const flashBaudRates = [115200, 230400, 460800, 921600, 1500000] as const
export const defaultFlashBaud: (typeof flashBaudRates)[number] = 460800

const readFileAsBinaryString = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const value = event.target?.result
      if (typeof value === 'string') {
        resolve(value)
        return
      }
      reject(new Error('Failed to read file as binary string'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsBinaryString(file)
  })

export const createFlashSession = (): FlashSession => ({
  port: null,
  transport: null,
  loader: null,
  chipInfo: null,
})

export const requestFlashPort = async (): Promise<SerialPort> => {
  if (!navigator.serial) {
    throw new Error('Web Serial unsupported in this browser')
  }
  return navigator.serial.requestPort()
}

export const detectChip = async (
  session: FlashSession,
  port: SerialPort,
  baudRate: number,
  terminal: FlashTerminal,
): Promise<FlashChipInfo> => {
  const transport = new Transport(port as never, true)
  const loader = new ESPLoader({
    transport,
    baudrate: baudRate,
    romBaudrate: 115200,
    terminal,
    debugLogging: false,
  })

  terminal.writeLine('Connecting to device...')
  const chip = await loader.main()
  terminal.writeLine(`Chip detected: ${chip}`)

  const chipInfo: FlashChipInfo = {
    chipFamily: loader.chip?.CHIP_NAME ?? chip ?? 'Unknown',
    chipName: chip ?? 'Unknown',
    macAddress: '',
  }

  try {
    const mac = await loader.chip?.readMac(loader)
    if (mac) {
      chipInfo.macAddress = mac
      terminal.writeLine(`MAC Address: ${mac}`)
    }
  } catch {
    // MAC read can fail on some chips - non-fatal.
  }

  session.port = port
  session.transport = transport
  session.loader = loader
  session.chipInfo = chipInfo

  return chipInfo
}

export const disconnectFlashSession = async (
  session: FlashSession,
  options: { hardReset?: boolean } = {},
) => {
  const { hardReset = true } = options
  if (hardReset && session.loader) {
    try {
      await session.loader.after('hard_reset')
    } catch {
      // Ignore reset failures during disconnect.
    }
  }
  if (session.transport) {
    try {
      await session.transport.disconnect()
    } catch {
      // Ignore disconnect failures.
    }
  }
  session.loader = null
  session.transport = null
  session.chipInfo = null
  session.port = null
}

export type FlashOptions = {
  files: FlashFile[]
  eraseAll: boolean
  compress: boolean
  flashMode?: string
  flashFreq?: string
  flashSize?: string
  onProgress: (fileIndex: number, written: number, total: number) => void
}

export const flashFirmware = async (
  session: FlashSession,
  options: FlashOptions,
  terminal: FlashTerminal,
): Promise<void> => {
  if (!session.loader) {
    throw new Error('ESP loader not initialized. Detect chip first.')
  }
  if (options.files.length === 0) {
    throw new Error('No firmware files selected')
  }

  const fileArray: { data: string; address: number }[] = []
  for (const item of options.files) {
    const binary = await readFileAsBinaryString(item.file)
    fileArray.push({ data: binary, address: item.address })
  }

  terminal.writeLine(`Preparing to flash ${fileArray.length} file(s)...`)
  if (options.eraseAll) {
    terminal.writeLine('Erasing flash...')
  }

  await session.loader.writeFlash({
    fileArray,
    flashSize: options.flashSize ?? 'keep',
    flashMode: options.flashMode ?? 'keep',
    flashFreq: options.flashFreq ?? 'keep',
    eraseAll: options.eraseAll,
    compress: options.compress,
    reportProgress: options.onProgress,
    calculateMD5Hash: () => '',
  })

  terminal.writeLine('Resetting device...')
  try {
    await session.loader.after('hard_reset', false)
    terminal.writeLine('Hard reset signal sent via RTS')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    terminal.writeLine(`Reset error: ${message}`)
  }

  terminal.writeLine('')
  terminal.writeLine('=== Flash complete! ===')
  terminal.writeLine(
    'If device did not restart automatically, press the RESET button on your board.',
  )
}

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export const formatAddress = (address: number): string =>
  `0x${address.toString(16).toUpperCase().padStart(4, '0')}`

export const parseAddress = (raw: string): number | null => {
  const cleaned = raw.replace(/^0x/i, '').trim()
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    return null
  }
  return Number.parseInt(cleaned, 16)
}
