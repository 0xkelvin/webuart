/**
 * Flash an IWR6843 radar image through the ESP32's console UART, mirroring
 * gm_radar/tools/flash_iwr6843_bridge.py.
 *
 * The carrier board's U6 mux routes the radar's flash UART to the ESP32 whenever
 * the ESP32 is attached, so the TI ROM bootloader can only be reached through
 * the ESP's console: `AT+RADARBOOT=BRIDGE` puts the radar into its ROM loader
 * and turns the ESP into a transparent byte bridge, after which this code
 * speaks TI's serial flashing protocol (SYNC packets, ACK 0xCC) end to end.
 *
 * Web Serial cannot change the baud rate of an open port, and the ESP raises
 * its console to 921600 once the bridge is up, so the port is closed and
 * reopened at the new rate — the same pattern esptool-js uses for its own
 * baud change.
 */

import { isNativeEspUsbPort, reacquirePortAfterReset } from './serialService'

export type RadarFlashRoute = 'auto' | 'buttons'

export type RadarFlashLogger = {
  /** Console text from the ESP while it is still speaking AT (not the binary bridge traffic). */
  onDeviceData: (chunk: string) => void
  onStatus: (line: string) => void
  onWarn: (line: string) => void
  onError: (line: string) => void
}

export type RadarFlashPhase =
  | 'at'
  | 'bridge'
  | 'buttons'
  | 'ping'
  | 'download'
  | 'close'
  | 'cleanup'
  | 'done'

export type RadarFlashProgress = {
  phase: RadarFlashPhase
  sent: number
  total: number
  bytesPerSecond: number
}

export type RadarFlashOptions = {
  port: SerialPort
  image: Uint8Array
  imageName: string
  route: RadarFlashRoute
  logger: RadarFlashLogger
  shouldCancel?: () => boolean
  onProgress?: (progress: RadarFlashProgress) => void
  /**
   * Buttons route only: resolves once the operator has held S1, tapped S2 and
   * released S1. Replaces the `input()` prompt of the Python script.
   */
  waitForButtons?: () => Promise<void>
}

export const AT_BAUD = 115200
/** Must match BRIDGE_CONSOLE_BAUD in gm_radar firmware/main/at_cmd.c. */
export const BRIDGE_BAUD = 921600

const ACK = 0xcc
const NACK = 0x33
const SYNC = 0xaa
const OP_PING = 0x20
const OP_START_DOWNLOAD = 0x21
const OP_FILE_CLOSE = 0x22
const OP_GET_STATUS = 0x23
const OP_SEND_DATA = 0x24
const RET_SUCCESS = 0x40
const CHUNK_SIZE = 240
const STORAGE_SFLASH = 2
const FILE_META_IMAGE1 = 4

const BRIDGE_MARKER = 'forwarding console <-> radar UART'
/**
 * The WiFi build raises its UART console for the bridge and announces the new
 * rate; the Ethernet build's console is USB, which has no rate to change, and
 * says so instead. Read the answer rather than assuming one.
 */
const BRIDGE_BAUD_LINE = /console switching to (\d+) baud/
const BRIDGE_BAUD_UNCHANGED = 'baud unchanged'
/** Firmware that drops the persisted bridge flag itself once the PC starts talking. */
const BRIDGE_SELF_CLEARING = 'flag clears itself'

/** Images the bench has proven to brick the board; refuse them by name. */
export const isBrokenImageName = (name: string): boolean => /^BROKEN-do-not-flash/i.test(name)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

class CancellationError extends Error {
  constructor() {
    super('Operation cancelled by user')
    this.name = 'CancellationError'
  }
}

const be16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff]
const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
]

const checksum = (bytes: ArrayLike<number>): number => {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 1) {
    sum = (sum + bytes[i]) & 0xff
  }
  return sum
}

const hex = (bytes: Uint8Array | null): string =>
  bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') : 'none'

/**
 * Byte-level reader/writer over a Web Serial port. Every received chunk feeds
 * both a byte queue (for the ROM protocol) and a text buffer (for AT markers).
 */
class BridgeSerial {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private decoder = new TextDecoder('utf-8', { fatal: false })
  private encoder = new TextEncoder()
  private chunks: Uint8Array[] = []
  private chunkOffset = 0
  private wake: (() => void) | null = null
  private text = ''
  private trimmedChars = 0
  private active = true
  private readPromise: Promise<void>
  private onText: ((chunk: string) => void) | null
  private static readonly MAX_TEXT = 200_000
  private static readonly TRIM_TEXT_TO = 100_000

  constructor(port: SerialPort, onText: ((chunk: string) => void) | null) {
    this.onText = onText
    if (!port.readable || !port.writable) {
      throw new Error('Serial port streams unavailable (not open?)')
    }
    this.reader = port.readable.getReader()
    this.writer = port.writable.getWriter()
    this.readPromise = this.runReadLoop()
  }

  private async runReadLoop(): Promise<void> {
    try {
      while (this.active) {
        const { value, done } = await this.reader.read()
        if (done) {
          break
        }
        if (value && value.length) {
          this.chunks.push(value)
          const text = this.decoder.decode(value, { stream: true })
          this.text += text
          if (this.text.length > BridgeSerial.MAX_TEXT) {
            const removed = this.text.length - BridgeSerial.TRIM_TEXT_TO
            this.text = this.text.slice(removed)
            this.trimmedChars += removed
          }
          if (this.onText) {
            try {
              this.onText(text)
            } catch {
              // A misbehaving listener must not stop the read loop.
            }
          }
          if (this.wake) {
            const wake = this.wake
            this.wake = null
            wake()
          }
        }
      }
    } catch {
      // Cancelled or the port went away; release() tidies up.
    } finally {
      this.active = false
      if (this.wake) {
        const wake = this.wake
        this.wake = null
        wake()
      }
    }
  }

  /** Stop forwarding console text to the logger (binary bridge traffic is not text). */
  muteText(): void {
    this.onText = null
  }

  mark(): number {
    return this.trimmedChars + this.text.length
  }

  /** Text received since `fromMark`, for parsing what the firmware announced. */
  textSince(fromMark: number): string {
    return this.text.slice(this.textIndexFor(fromMark))
  }

  private textIndexFor(mark: number): number {
    return Math.max(0, mark - this.trimmedChars)
  }

  async waitForText(
    marker: string,
    timeoutMs: number,
    fromMark: number,
    shouldCancel?: () => boolean,
    spam?: string,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let nextSpam = 0
    while (Date.now() < deadline) {
      if (shouldCancel?.()) {
        throw new CancellationError()
      }
      if (spam && Date.now() >= nextSpam) {
        await this.writeText(spam)
        nextSpam = Date.now() + 200
      }
      const from = Math.max(0, this.textIndexFor(fromMark) - marker.length)
      if (this.text.indexOf(marker, from) >= 0) {
        return true
      }
      await sleep(20)
    }
    return false
  }

  discardInput(): void {
    this.chunks = []
    this.chunkOffset = 0
  }

  private queuedBytes(): number {
    let total = -this.chunkOffset
    for (const chunk of this.chunks) {
      total += chunk.length
    }
    return total
  }

  private takeByte(): number {
    const chunk = this.chunks[0]
    const value = chunk[this.chunkOffset]
    this.chunkOffset += 1
    if (this.chunkOffset >= chunk.length) {
      this.chunks.shift()
      this.chunkOffset = 0
    }
    return value
  }

  private async waitForBytes(deadline: number): Promise<boolean> {
    while (this.queuedBytes() === 0) {
      if (!this.active) {
        return false
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return false
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
        setTimeout(resolve, Math.min(remaining, 50))
      })
    }
    return true
  }

  async readByte(timeoutMs: number): Promise<number | null> {
    const deadline = Date.now() + timeoutMs
    if (!(await this.waitForBytes(deadline))) {
      return null
    }
    return this.takeByte()
  }

  async readExact(count: number, timeoutMs: number): Promise<Uint8Array | null> {
    const deadline = Date.now() + timeoutMs
    const out = new Uint8Array(count)
    for (let i = 0; i < count; i += 1) {
      if (!(await this.waitForBytes(deadline))) {
        return null
      }
      out[i] = this.takeByte()
    }
    return out
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.writer.write(bytes)
  }

  async writeText(text: string): Promise<void> {
    await this.writer.write(this.encoder.encode(text))
  }

  async release(): Promise<void> {
    this.active = false
    try {
      await this.reader.cancel()
    } catch {
      // Already cancelled or the port is gone.
    }
    try {
      this.reader.releaseLock()
    } catch {
      // Already released.
    }
    try {
      await this.writer.close()
    } catch {
      // Already closed.
    }
    try {
      this.writer.releaseLock()
    } catch {
      // Already released.
    }
    try {
      await this.readPromise
    } catch {
      // The pending read has already failed.
    }
  }
}

const setSignals = async (
  port: SerialPort,
  signals: { dataTerminalReady?: boolean; requestToSend?: boolean },
): Promise<void> => {
  if (typeof port.setSignals !== 'function') {
    throw new Error('Browser does not support port.setSignals (needed to reset the ESP32)')
  }
  await port.setSignals(signals)
}

/** Pulse EN through RTS with DTR released, so GPIO0 stays high and the ESP boots normally. */
const resetEsp = async (port: SerialPort): Promise<void> => {
  await setSignals(port, { dataTerminalReady: false, requestToSend: true })
  await sleep(100)
  await setSignals(port, { requestToSend: false })
}


/**
 * Reopen the port at another baud rate. The browser asserts DTR and RTS
 * together on open, which the ESP's auto-reset circuit ignores; they are then
 * released RTS first, because dropping DTR while RTS is still asserted is the
 * reset pulse itself.
 */
const reopenAt = async (port: SerialPort, baudRate: number): Promise<void> => {
  await port.close()
  await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' })
  await setSignals(port, { requestToSend: false })
  await setSignals(port, { dataTerminalReady: false })
}

const buildPacket = (payload: number[] | Uint8Array): Uint8Array => {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload)
  const packet = new Uint8Array(4 + body.length)
  packet[0] = SYNC
  packet.set(be16(body.length + 2), 1)
  packet[3] = checksum(body)
  packet.set(body, 4)
  return packet
}

type AckResult = { ok: boolean | null; seen: Uint8Array }

/** Collect bytes until ACK or NACK; TI's loader reads a 2-byte size then scans the same way. */
const readAck = async (serial: BridgeSerial, timeoutMs: number): Promise<AckResult> => {
  const deadline = Date.now() + timeoutMs
  const seen: number[] = []
  while (Date.now() < deadline) {
    const byte = await serial.readByte(deadline - Date.now())
    if (byte === null) {
      break
    }
    seen.push(byte)
    if (byte === ACK) {
      return { ok: true, seen: Uint8Array.from(seen) }
    }
    if (byte === NACK) {
      return { ok: false, seen: Uint8Array.from(seen) }
    }
  }
  return { ok: null, seen: Uint8Array.from(seen) }
}

const receivePacket = async (
  serial: BridgeSerial,
  timeoutMs: number,
  warn: (line: string) => void,
): Promise<Uint8Array | null> => {
  const header = await serial.readExact(3, timeoutMs)
  if (!header) {
    return null
  }
  const length = (header[0] << 8) | header[1]
  const payload = await serial.readExact(Math.max(0, length - 2), timeoutMs)
  if (!payload) {
    return null
  }
  await serial.write(Uint8Array.from([ACK])) // the loader expects every packet acknowledged
  if (checksum(payload) !== header[2]) {
    warn(`status checksum mismatch: ${hex(payload)}`)
  }
  return payload
}

type CommandResult = { ok: boolean | null; seen: Uint8Array; status: Uint8Array | null }

/** Send one command, read its ACK, then fetch and acknowledge the status packet. */
const sendCommand = async (
  serial: BridgeSerial,
  payload: number[] | Uint8Array,
  ackTimeoutMs: number,
  warn: (line: string) => void,
): Promise<CommandResult> => {
  await serial.write(buildPacket(payload))
  const first = await readAck(serial, ackTimeoutMs)
  if (first.ok !== true) {
    return { ok: first.ok, seen: first.seen, status: null }
  }
  await serial.write(buildPacket([OP_GET_STATUS]))
  const second = await readAck(serial, ackTimeoutMs)
  if (second.ok !== true) {
    return { ok: second.ok, seen: Uint8Array.from([...first.seen, ...second.seen]), status: null }
  }
  const status = await receivePacket(serial, ackTimeoutMs, warn)
  return { ok: true, seen: first.seen, status }
}

const statusOk = (result: CommandResult): boolean =>
  result.ok === true && (result.status === null || result.status[0] === RET_SUCCESS)

/**
 * Drive the whole flow: AT window → bridge → (buttons) → ROM protocol → cleanup.
 * Resolves true only when FILE_CLOSE was acknowledged. Cleanup runs whenever the
 * bridge was armed, including after a failure or a cancel, so the board is never
 * left in bridge mode.
 */
export const flashRadarImage = async (options: RadarFlashOptions): Promise<boolean> => {
  const { port, image, imageName, route, logger, shouldCancel, onProgress, waitForButtons } =
    options
  const status = (line: string) => logger.onStatus(line)
  const warn = (line: string) => logger.onWarn(line)
  const error = (line: string) => logger.onError(line)
  const report = (phase: RadarFlashPhase, sent: number, bytesPerSecond = 0) =>
    onProgress?.({ phase, sent, total: image.length, bytesPerSecond })

  if (isBrokenImageName(imageName)) {
    error(`Refusing to flash "${imageName}": images with this name are known to brick the board.`)
    return false
  }
  if (image.length === 0) {
    error('The selected image is empty.')
    return false
  }
  if (route === 'buttons' && !waitForButtons) {
    error('Buttons route needs an operator confirmation step.')
    return false
  }

  status(`Image : ${imageName}`)
  status(`Size  : ${image.length} bytes`)

  const portWasOpen = port.readable !== null && port.writable !== null
  if (!portWasOpen) {
    status(`Opening port @ ${AT_BAUD} baud...`)
    await port.open({ baudRate: AT_BAUD, dataBits: 8, stopBits: 1, parity: 'none' })
  }

  let serial = new BridgeSerial(port, logger.onDeviceData)
  let armed = false
  let currentBaud = AT_BAUD
  let flagSelfClears = false

  const switchBaud = async (baudRate: number, forwardText: boolean): Promise<void> => {
    await serial.release()
    await reopenAt(port, baudRate)
    serial = new BridgeSerial(port, forwardText ? logger.onDeviceData : null)
    currentBaud = baudRate
  }

  const cleanup = async (): Promise<void> => {
    report('cleanup', image.length)
    status('[cleanup] Clearing RADARBRIDGE flag ...')
    if (currentBaud !== AT_BAUD) {
      await switchBaud(AT_BAUD, true)
    }
    await resetEsp(port)
    // The reset takes a native-USB board off the bus here exactly as it does on
    // the way in. Skipping this leaves RADARBRIDGE set, and the board then boots
    // straight into the bridge on every power-up instead of running its app.
    if (isNativeEspUsbPort(port)) {
      await serial.release()
      await reacquirePortAfterReset(port, AT_BAUD, { onStatus: status })
      serial = new BridgeSerial(port, logger.onDeviceData)
    }
    const mark = serial.mark()
    if (!(await serial.waitForText('<= OK', 15_000, mark, undefined, 'AT\r\n'))) {
      if (flagSelfClears) {
        warn(
          '[cleanup] no AT window, but this firmware clears RADARBRIDGE itself once ' +
            'the PC starts talking to the bridge, so the board comes back normally on ' +
            'its next reset or power-up.',
        )
      } else {
        error(
          '[cleanup] no AT window. RADARBRIDGE is still set, so the board will boot ' +
            'into the bridge instead of running its application. Reconnect and send ' +
            'AT+RADARBOOT=OFF before using it.',
        )
      }
      return
    }
    const offMark = serial.mark()
    await serial.writeText('AT+RADARBOOT=OFF\r\n')
    await serial.waitForText('RADARBOOT=OFF', 5_000, offMark)
    await serial.writeText('AT+RST\r\n')
    await sleep(1_000)
    status('[cleanup] Done; ESP rebooting normally, radar reset to app boot.')
  }

  try {
    // 1. Reset the ESP and catch its boot-time AT window. The port has to be
    //    reopened in between, while nothing holds its streams.
    report('at', 0)
    status('[bridge] entering AT window ...')
    await setSignals(port, { dataTerminalReady: false, requestToSend: false })
    await resetEsp(port)
    if (isNativeEspUsbPort(port)) {
      // Only this kind of board loses its USB device to the reset. Releasing the
      // streams anywhere else would close the writer for a port that is still
      // perfectly good, and it could not be reclaimed without a reopen.
      await serial.release()
      await reacquirePortAfterReset(port, AT_BAUD, { onStatus: status })
      serial = new BridgeSerial(port, logger.onDeviceData)
    }
    if (!(await serial.waitForText('<= OK', 15_000, serial.mark(), shouldCancel, 'AT\r\n'))) {
      error('[bridge] FAIL: no AT window (is this the ESP console port, running gm_radar firmware?)')
      return false
    }

    // 2. Arm the bridge. BRIDGE enters the ROM loader now through the SOP2 bodge
    //    wire; AUTO persists a bridge-on-boot flag for the S1/S2 button route.
    report('bridge', 0)
    const command = route === 'buttons' ? 'AT+RADARBOOT=AUTO' : 'AT+RADARBOOT=BRIDGE'
    status(`[bridge] ${command}`)
    const bridgeMark = serial.mark()
    await serial.writeText(`${command}\r\n`)
    armed = true
    if (!(await serial.waitForText(BRIDGE_MARKER, 25_000, bridgeMark, shouldCancel))) {
      error('[bridge] FAIL: bridge marker not seen')
      return false
    }

    // 3. Follow whatever the firmware just said about the console rate.
    await sleep(300)
    const announced = serial.textSince(bridgeMark)
    const match = announced.match(BRIDGE_BAUD_LINE)
    flagSelfClears = announced.includes(BRIDGE_SELF_CLEARING)
    serial.muteText()
    if (match) {
      await switchBaud(Number(match[1]), false)
      status(`[bridge] console link raised to ${match[1]} baud`)
    } else if (announced.includes(BRIDGE_BAUD_UNCHANGED)) {
      status('[bridge] console is USB; keeping the port as it is')
    } else {
      // Older firmware that announced nothing: the UART builds all use this rate.
      await switchBaud(BRIDGE_BAUD, false)
      status(`[bridge] no rate announced; assuming ${BRIDGE_BAUD} baud`)
    }

    if (route === 'buttons' && waitForButtons) {
      report('buttons', 0)
      status('Bridge up. Hold S1, tap S2, keep S1 held ~1 s, release, then confirm.')
      await waitForButtons()
      if (shouldCancel?.()) {
        throw new CancellationError()
      }
      await sleep(2_500) // a post-press ESP reboot re-enters the bridge
    }
    serial.discardInput()

    // 4. ROM loader handshake.
    report('ping', 0)
    status('[flash] PING ...')
    let pinged = false
    for (let attempt = 0; attempt < 6 && !pinged; attempt += 1) {
      if (shouldCancel?.()) {
        throw new CancellationError()
      }
      const result = await sendCommand(serial, [OP_PING], 3_000, warn)
      status(`  attempt ${attempt}: ack=${result.ok} status=${hex(result.status)}`)
      pinged = result.ok === true
      if (!pinged) {
        await sleep(2_000)
      }
    }
    if (!pinged) {
      error("[flash] FAIL: no ACK to PING — did the ESP report 'ROM ACK 0xCC'?")
      return false
    }

    // 5. START_DOWNLOAD into serial flash as META_IMAGE1.
    status(`[flash] START_DOWNLOAD size=${image.length} storage=SFLASH file=META_IMAGE1 ...`)
    const start = await sendCommand(
      serial,
      [
        OP_START_DOWNLOAD,
        ...be32(image.length),
        ...be32(STORAGE_SFLASH),
        ...be32(FILE_META_IMAGE1),
        ...be32(0),
      ],
      30_000,
      warn,
    )
    status(`  ack=${start.ok} status=${hex(start.status)}`)
    if (!statusOk(start)) {
      error('[flash] FAIL: START_DOWNLOAD rejected')
      return false
    }

    // 6. Data, 240 bytes per packet, each acknowledged and status-checked.
    status('[flash] Sending data ...')
    const startedAt = Date.now()
    let offset = 0
    let packets = 0
    while (offset < image.length) {
      if (shouldCancel?.()) {
        throw new CancellationError()
      }
      const chunk = image.subarray(offset, offset + CHUNK_SIZE)
      const payload = new Uint8Array(1 + chunk.length)
      payload[0] = OP_SEND_DATA
      payload.set(chunk, 1)
      const result = await sendCommand(serial, payload, 10_000, warn)
      if (!statusOk(result)) {
        error(`[flash] FAIL at offset ${offset}: ack=${result.ok} status=${hex(result.status)}`)
        return false
      }
      offset += chunk.length
      packets += 1
      const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001)
      const rate = offset / elapsed
      report('download', offset, rate)
      if (packets % 100 === 0 || offset >= image.length) {
        const percent = Math.floor((offset * 100) / image.length)
        status(`  ${offset}/${image.length} (${percent}%)  ${rate.toFixed(0)} B/s`)
      }
    }

    // 7. FILE_CLOSE commits the image.
    report('close', image.length)
    status('[flash] FILE_CLOSE ...')
    const close = await sendCommand(serial, [OP_FILE_CLOSE, ...be32(FILE_META_IMAGE1)], 30_000, warn)
    status(`  ack=${close.ok} status=${hex(close.status)}`)
    if (close.ok !== true) {
      error('[flash] FAIL: FILE_CLOSE not acked')
      return false
    }

    status('')
    status('FLASH COMPLETED THROUGH ESP BRIDGE')
    return true
  } catch (err) {
    if (err instanceof CancellationError) {
      warn('Cancelled by user.')
      return false
    }
    const message = err instanceof Error ? err.message : String(err)
    error(`Radar flash failed: ${message}`)
    return false
  } finally {
    if (armed) {
      try {
        await cleanup()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        error(`[cleanup] ERROR: ${message}`)
      }
    }
    await serial.release()
    report('done', image.length)
  }
}

export const requestRadarPort = async (): Promise<SerialPort> => {
  if (!navigator.serial) {
    throw new Error('Web Serial unavailable in this browser')
  }
  return navigator.serial.requestPort()
}

export const closeRadarPort = async (port: SerialPort): Promise<void> => {
  try {
    await port.close()
  } catch {
    // Already closed or never opened.
  }
}
