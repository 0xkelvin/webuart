export type ResetMode = 'rts_dtr' | 'dtr' | 'usb_jtag' | 'none'
export type EndCommand = 'cont' | 'rst'

export type ConfigLogger = {
  /** Raw bytes received from the device (passthrough console). */
  onDeviceData: (chunk: string) => void
  /** Status messages from the tool itself. */
  onStatus: (line: string) => void
  /** Warnings (non-fatal). */
  onWarn: (line: string) => void
  /** Errors (fatal). */
  onError: (line: string) => void
}

export type ApplyConfigProgress = {
  /** Current step number (1-based). */
  step: number
  /** Total expected steps in the apply flow. */
  total: number
  /** Short human label for the current step (e.g. "WIFISSID"). */
  label: string
  /**
   * Phase of the apply flow. UI can use this to show "indeterminate" progress
   * for the boot/AT-mode wait (which can take 18+ seconds with retries).
   */
  phase: 'boot' | 'write' | 'finalize' | 'done'
}

export type ApplyConfigOptions = {
  port: SerialPort
  config: Record<string, unknown>
  configFilename: string
  resetMode: ResetMode
  endCommand: EndCommand
  baudRate?: number
  logger: ConfigLogger
  shouldCancel?: () => boolean
  onProgress?: (progress: ApplyConfigProgress) => void
}

// Whitelist mirrors AT_MAP in configure_device.py. Other JSON keys are skipped.
export const CONFIG_AT_KEYS = [
  'WIFISSID',
  'WIFIPWD',
  'MQTTADD',
  'MQTTPRT',
  'MQTTGRP',
  'MQTTKL',
  'TYPE',
  'REPORTINT',
  'RADARCONFIG',
  'REBOOTTIME',
  'CFGFILE',
  'LOCALMODE',
  'CFGTIME',
] as const

const AT_KEY_SET = new Set<string>(CONFIG_AT_KEYS as unknown as string[])

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

class CancellationError extends Error {
  constructor() {
    super('Operation cancelled by user')
    this.name = 'CancellationError'
  }
}

/**
 * Background reader + ergonomic writer wrapper around a Web Serial port.
 * Buffers incoming text so we can do esptool-style "wait for marker" reads.
 */
class AtSerial {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private decoder = new TextDecoder('utf-8', { fatal: false })
  private encoder = new TextEncoder()
  private buffer = ''
  private readActive = true
  private readPromise: Promise<void>
  private listeners: Array<(chunk: string) => void> = []
  private static readonly MAX_BUFFER = 200_000
  private static readonly TRIM_TO = 100_000

  constructor(port: SerialPort) {
    if (!port.readable || !port.writable) {
      throw new Error('Serial port streams unavailable (not open?)')
    }
    this.reader = port.readable.getReader()
    this.writer = port.writable.getWriter()
    this.readPromise = this.runReadLoop()
  }

  onData(callback: (chunk: string) => void): void {
    this.listeners.push(callback)
  }

  private async runReadLoop(): Promise<void> {
    try {
      while (this.readActive) {
        const { value, done } = await this.reader.read()
        if (done) {
          break
        }
        if (value && value.length) {
          const text = this.decoder.decode(value, { stream: true })
          this.buffer += text
          if (this.buffer.length > AtSerial.MAX_BUFFER) {
            this.buffer = this.buffer.slice(-AtSerial.TRIM_TO)
          }
          for (const listener of this.listeners) {
            try {
              listener(text)
            } catch {
              // Ignore listener errors so a bad consumer doesn't kill the loop.
            }
          }
        }
      }
    } catch {
      // Read cancelled or errored; release path will tidy up.
    }
  }

  /** Snapshot of the receive buffer length, useful as a mark for waitForString. */
  mark(): number {
    return this.buffer.length
  }

  /** Wait for `keyword` to appear anywhere from `fromMark` onwards. */
  async waitForString(
    keyword: string,
    timeoutMs: number,
    fromMark = 0,
    shouldCancel?: () => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (shouldCancel?.()) {
        throw new CancellationError()
      }
      const haystackStart = Math.max(0, fromMark - keyword.length)
      if (this.buffer.indexOf(keyword, haystackStart) >= 0) {
        return true
      }
      await sleep(40)
    }
    return false
  }

  /** Wait for any of `keywords` (returns the first one matched, or null on timeout). */
  async waitForAnyString(
    keywords: string[],
    timeoutMs: number,
    fromMark = 0,
    shouldCancel?: () => boolean,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (shouldCancel?.()) {
        throw new CancellationError()
      }
      const haystackStart = Math.max(0, fromMark - 64)
      const slice = this.buffer.slice(haystackStart)
      for (const k of keywords) {
        if (slice.indexOf(k) >= 0) {
          return k
        }
      }
      await sleep(40)
    }
    return null
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.writer.write(bytes)
  }

  async writeText(text: string): Promise<void> {
    await this.writer.write(this.encoder.encode(text))
  }

  /**
   * Send long payload in small chunks with inter-chunk delays so the firmware
   * UART RX FIFO (128 B HW limit) can drain between bursts.
   */
  async writeChunked(text: string, chunkSize = 64, delayMs = 15): Promise<void> {
    const raw = this.encoder.encode(text)
    for (let offset = 0; offset < raw.length; offset += chunkSize) {
      await this.writer.write(raw.slice(offset, offset + chunkSize))
      if (delayMs > 0 && offset + chunkSize < raw.length) {
        await sleep(delayMs)
      }
    }
  }

  async release(): Promise<void> {
    this.readActive = false
    try {
      await this.reader.cancel()
    } catch {
      // Already cancelled / port closed.
    }
    try {
      this.reader.releaseLock()
    } catch {
      // Reader may already be released.
    }
    try {
      await this.writer.close()
    } catch {
      // Writer may already be closed.
    }
    try {
      this.writer.releaseLock()
    } catch {
      // Writer may already be released.
    }
    try {
      await this.readPromise
    } catch {
      // Pending read should already have errored out.
    }
  }
}

const setSignalsSafe = async (
  port: SerialPort,
  signals: { dataTerminalReady?: boolean; requestToSend?: boolean },
): Promise<void> => {
  if (typeof port.setSignals !== 'function') {
    throw new Error('Browser does not support port.setSignals (reset signals)')
  }
  await port.setSignals(signals)
}

const resetViaRtsDtr = async (port: SerialPort): Promise<void> => {
  // Matches configure_device.py reset_mode='rts_dtr'.
  // Step 1: DTR=1 (GPIO0 LOW), RTS=0 (EN HIGH = running)
  await setSignalsSafe(port, { dataTerminalReady: true, requestToSend: false })
  await sleep(100)
  // Step 2: DTR=0 (GPIO0 released), RTS=1 (EN LOW = reset pulse)
  await setSignalsSafe(port, { dataTerminalReady: false, requestToSend: true })
  await sleep(200)
  // Step 3: release reset
  await setSignalsSafe(port, { requestToSend: false })
  await sleep(100)
}

const resetViaDtrOnly = async (port: SerialPort): Promise<void> => {
  await setSignalsSafe(port, { dataTerminalReady: false })
  await sleep(100)
  await setSignalsSafe(port, { dataTerminalReady: true })
  await sleep(100)
  await setSignalsSafe(port, { dataTerminalReady: false })
}

const resetViaUsbJtag = async (port: SerialPort, baudRate: number): Promise<SerialPort> => {
  // ESP32-S3 internal USB-Serial/JTAG: close port to deassert DTR (chip resets
  // on USB disconnect), then reopen and pulse DTR for a clean reset.
  try {
    await port.close()
  } catch {
    // Port might already be in a closed state.
  }
  await sleep(500)
  await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' })
  await setSignalsSafe(port, { dataTerminalReady: false })
  await sleep(100)
  await setSignalsSafe(port, { dataTerminalReady: true })
  await sleep(100)
  await setSignalsSafe(port, { dataTerminalReady: false })
  return port
}

/**
 * Spam AT\r\n every 180 ms until the firmware echoes "OK", up to `timeoutMs`.
 * Matches wait_for_at_ok() in configure_device.py.
 */
const probeAtUntilOk = async (
  serial: AtSerial,
  timeoutMs: number,
  shouldCancel?: () => boolean,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  const okMarkers = ['<= OK', '\nOK\r\n', '\nOK\n']
  let nextSend = 0
  const startMark = serial.mark()
  while (Date.now() < deadline) {
    if (shouldCancel?.()) {
      throw new CancellationError()
    }
    const now = Date.now()
    if (now >= nextSend) {
      await serial.writeText('AT\r\n')
      nextSend = now + 180
    }
    const haystack = serial.mark() - startMark
    if (haystack > 0) {
      // Peek into buffer via waitForString with a tiny timeout.
      const got = await serial.waitForAnyString(okMarkers, 50, startMark, shouldCancel)
      if (got) {
        return true
      }
    } else {
      await sleep(40)
    }
  }
  return false
}

const utcTimestamp = (): string => {
  const date = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  )
}

/**
 * Send `AT+KEY=VALUE\r\n` (chunked for long values), wait for the firmware to
 * echo back `KEY=` (any case) within a generous timeout. Returns true on success.
 */
const sendAtAssignment = async (
  serial: AtSerial,
  key: string,
  value: string,
  shouldCancel?: () => boolean,
  timeoutMs = 5000,
): Promise<boolean> => {
  const startMark = serial.mark()
  const command = `AT+${key}=${value}\r\n`
  await serial.writeChunked(command, 64, 15)
  return serial.waitForString(`${key}=`, timeoutMs, startMark, shouldCancel)
}

/**
 * Apply a JSON config to a running ESP32-S3 mmWave Radar firmware over UART,
 * mirroring `configure_device.py`. The caller passes an *already-permission-
 * granted* SerialPort (e.g. from `navigator.serial.requestPort()`). If the port
 * is not open we'll open it at `baudRate` (default 115200).
 */
export const applyConfig = async (options: ApplyConfigOptions): Promise<boolean> => {
  const {
    port,
    config,
    configFilename,
    resetMode,
    endCommand,
    baudRate = 115200,
    logger,
    shouldCancel,
    onProgress,
  } = options

  const status = (msg: string) => logger.onStatus(msg)
  const warn = (msg: string) => logger.onWarn(msg)
  const error = (msg: string) => logger.onError(msg)

  // Pre-compute total steps for the progress bar:
  //   1 boot/AT wait + 3 metadata writes (CFGFILE, CFGTIME, CFGSOURCE)
  //   + N whitelisted config keys + 1 finalize (AT+CONT or AT+RST=)
  const writableEntries = Object.entries(config).filter(([key]) => AT_KEY_SET.has(key))
  const totalSteps = 1 + 3 + writableEntries.length + 1
  let stepIndex = 0
  const reportProgress = (label: string, phase: ApplyConfigProgress['phase']) => {
    stepIndex += 1
    onProgress?.({ step: stepIndex, total: totalSteps, label, phase })
  }

  // Step 1: open port if not already open.
  const portWasAlreadyOpen = port.readable !== null && port.writable !== null
  if (!portWasAlreadyOpen) {
    status(`Opening port @ ${baudRate} baud...`)
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' })
  } else {
    status(`Reusing already-open port @ ${baudRate} baud`)
  }
  await setSignalsSafe(port, { dataTerminalReady: false, requestToSend: false })

  // For usb_jtag mode we close-reopen the port before claiming streams.
  let workingPort = port
  if (resetMode === 'usb_jtag') {
    status('Resetting via USB-JTAG (close + reopen + DTR pulse)...')
    workingPort = await resetViaUsbJtag(port, baudRate)
  }

  const serial = new AtSerial(workingPort)
  serial.onData(logger.onDeviceData)

  try {
    // Step 2: trigger a reset (unless usb_jtag, which already did it above).
    if (resetMode === 'rts_dtr') {
      status('Resetting board via RTS/DTR sequence...')
      await resetViaRtsDtr(workingPort)
    } else if (resetMode === 'dtr') {
      status('Resetting board via DTR-only toggle...')
      await resetViaDtrOnly(workingPort)
    } else if (resetMode === 'none') {
      status('Manual reset mode: press the RESET button on the board now.')
    }

    // Step 3 + 4: wait for bootInit() marker, then spam AT until OK.
    status('Waiting for boot + AT window...')
    const MAX_TRIES = 5
    let enteredAt = false
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      if (shouldCancel?.()) {
        throw new CancellationError()
      }
      const bootMark = serial.mark()
      const found = await serial.waitForString('bootInit()', 18_000, bootMark, shouldCancel)
      if (!found) {
        warn(`Attempt ${attempt}: bootInit() marker missed. Trying blind AT probe...`)
        if (await probeAtUntilOk(serial, 4000, shouldCancel)) {
          enteredAt = true
          break
        }
        continue
      }
      status(`[Attempt ${attempt}] bootInit() seen — probing AT window`)
      if (await probeAtUntilOk(serial, 4000, shouldCancel)) {
        enteredAt = true
        break
      }
      // Grace period: response can arrive right after we stop probing.
      status('Grace probe for late OK...')
      if (await probeAtUntilOk(serial, 1200, shouldCancel)) {
        enteredAt = true
        break
      }
      warn('No AT OK in this window, retrying on next boot cycle...')
    }

    if (!enteredAt) {
      error(
        `Could not enter AT mode after ${MAX_TRIES} attempts. ` +
          'Make sure the board is running firmware (not in bootloader) and the baud rate is 115200.',
      )
      return false
    }

    status('[Entered AT Mode]')
    reportProgress('Entered AT mode', 'write')

    // Step 5: informational AT+VER and AT+MAC. Best-effort — don't bail on miss.
    {
      const mark = serial.mark()
      await serial.writeText('AT+VER\r\n')
      await serial.waitForString('\r\n\r\n', 1500, mark, shouldCancel)
    }
    {
      const mark = serial.mark()
      await serial.writeText('AT+MAC\r\n')
      await serial.waitForString('\r\n\r\n', 1500, mark, shouldCancel)
    }

    // Step 6: send mandatory metadata keys.
    const metaSend = async (key: string, value: string) => {
      status(`[${stepIndex + 1}/${totalSteps}] Write ${key} = ${value}`)
      const ok = await sendAtAssignment(serial, key, value, shouldCancel)
      reportProgress(key, 'write')
      if (!ok) {
        warn(`${key}: no echo within timeout`)
      }
      return ok
    }

    await metaSend('CFGFILE', configFilename)
    await metaSend('CFGTIME', utcTimestamp())
    await metaSend('CFGSOURCE', 'AT')

    // Step 7: iterate JSON keys (whitelist only, mirrors AT_MAP in the .py).
    // Unknown keys are logged as skipped but do NOT consume a progress step
    // (they weren't counted in totalSteps).
    const entries = Object.entries(config)
    status(`[Load Config] Sending ${writableEntries.length} config key(s)...`)

    let okCount = 0
    let warnCount = 0
    let skipCount = 0
    for (const [key, rawValue] of entries) {
      if (shouldCancel?.()) {
        throw new CancellationError()
      }
      if (!AT_KEY_SET.has(key)) {
        warn(`[SKIP] Unknown key: ${key}`)
        skipCount += 1
        continue
      }
      const value = typeof rawValue === 'string' ? rawValue : String(rawValue)
      const shortVal = value.length > 60 ? `${value.slice(0, 60)}...` : value
      status(`[${stepIndex + 1}/${totalSteps}] Write ${key} = ${shortVal}`)
      const ok = await sendAtAssignment(serial, key, value, shouldCancel)
      reportProgress(key, 'write')
      if (ok) {
        okCount += 1
      } else {
        warnCount += 1
        warn(`${key}: no echo within timeout — value may still have been written.`)
      }
    }

    // Step 8: end command.
    if (endCommand === 'cont') {
      status('-> AT+CONT (continue boot, no reboot)')
      await serial.writeText('AT+CONT\r\n')
      await sleep(500)
      reportProgress('AT+CONT sent', 'finalize')
    } else {
      status('-> AT+RST= (save & reboot)')
      await serial.writeText('AT+RST=\r\n')
      reportProgress('AT+RST= sent', 'finalize')
      // Stream the reboot log for ~12s so the user can see boot output.
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        if (shouldCancel?.()) {
          throw new CancellationError()
        }
        await sleep(200)
      }
    }

    onProgress?.({ step: totalSteps, total: totalSteps, label: 'done', phase: 'done' })
    status(`Configuration COMPLETE — ok=${okCount}, warn=${warnCount}, skip=${skipCount}`)
    return true
  } catch (err) {
    if (err instanceof CancellationError) {
      warn('Cancelled by user.')
      return false
    }
    const message = err instanceof Error ? err.message : String(err)
    error(`Apply config failed: ${message}`)
    return false
  } finally {
    await serial.release()
  }
}

export const requestConfigPort = async (): Promise<SerialPort> => {
  if (!navigator.serial) {
    throw new Error('Web Serial unavailable in this browser')
  }
  return navigator.serial.requestPort()
}

export const closePortSafely = async (port: SerialPort): Promise<void> => {
  try {
    await port.close()
  } catch {
    // Already closed or never opened.
  }
}

export const parseJsonConfig = (
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Expected a JSON object at the top level' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'invalid JSON',
    }
  }
}
