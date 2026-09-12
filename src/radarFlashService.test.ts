import { describe, expect, it } from 'vitest'
import {
  AT_BAUD,
  BRIDGE_BAUD,
  flashRadarImage,
  isBrokenImageName,
  type RadarFlashLogger,
  type RadarFlashProgress,
} from './radarFlashService'

/**
 * A fake GM1000 board: the ESP32 console (gm_radar at_cmd.c) in front of the
 * IWR6843 ROM bootloader, reachable only through the ESP's bridge.
 *
 * It models the three things the real flow depends on and a browser cannot
 * fake by accident:
 *  - the ESP's auto-reset circuit: EN is low exactly while RTS is asserted and
 *    DTR is not, and the chip boots when that pulse ends;
 *  - the console baud jump: once the bridge is up, bytes only reach the ROM if
 *    the port was reopened at 921600;
 *  - TI's packet framing: SYNC, big-endian length, checksum, ACK/NACK, and the
 *    status packet that must itself be acknowledged.
 */
type BoardOptions = {
  /** Make START_DOWNLOAD fail: the ROM NACKs it, or ACKs with a non-success status. */
  failStart?: 'nack' | 'status'
  /**
   * Model the Ethernet build: the console is the ESP32-S3's own USB, so the
   * bridge announces no rate change and the ROM stays reachable at the console
   * rate. A client that switches to 921600 anyway stops being understood.
   */
  usbConsole?: boolean
  /**
   * Model the Ethernet board's USB: the device is the ESP32-S3 itself, so a
   * reset takes it off the bus. The handle held across that keeps delivering
   * output while every write is silently dropped — the exact half-dead state
   * that made the tool retry five times and stop. Opening the port again is
   * what picks up the device that came back.
   */
  nativeUsb?: boolean
}

class FakeBoard {
  // Web Serial exposes null streams while the port is closed; the client relies on that.
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private readableClosed = true
  baudRate: number | null = null
  state: 'app' | 'bridge' = 'app'
  private signals = { dtr: false, rts: false }
  private enLow = false
  boots = 0
  atLines: string[] = []
  garbageBytes = 0
  strayBytes = 0
  nacks = 0
  // ROM state
  private rx: number[] = []
  private expectingClientAck = false
  startDownload: { size: number; storage: number; fileMeta: number } | null = null
  received: number[] = []
  packetSizes: number[] = []
  fileClosed = false
  pings = 0
  private encoder = new TextEncoder()
  private decoder = new TextDecoder()
  private lineBuffer = ''
  private options: BoardOptions

  constructor(options: BoardOptions = {}) {
    this.options = options
  }

  /** Set on a native-USB board by a reset; cleared by reopening the port. */
  private staleHandle = false
  droppedWrites = 0

  getInfo() {
    return this.options.nativeUsb
      ? { usbVendorId: 0x303a, usbProductId: 0x1001 }
      : { usbVendorId: 0x1a86, usbProductId: 0x55d3 }
  }

  async open(options: { baudRate: number }): Promise<void> {
    this.baudRate = options.baudRate
    this.staleHandle = false
    this.readableClosed = false
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
      },
      cancel: () => {
        this.readableClosed = true
      },
    })
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => this.onHostBytes(chunk),
    })
    // Chromium asserts both control lines on open; with both asserted the
    // auto-reset circuit pulls neither EN nor GPIO0.
    await this.setSignals({ dataTerminalReady: true, requestToSend: true })
  }

  async close(): Promise<void> {
    this.baudRate = null
    if (!this.readableClosed) {
      this.readableClosed = true
      try {
        this.controller?.close()
      } catch {
        // Already closed by a cancel.
      }
    }
    this.readable = null
    this.writable = null
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }) {
    if (signals.dataTerminalReady !== undefined) this.signals.dtr = signals.dataTerminalReady
    if (signals.requestToSend !== undefined) this.signals.rts = signals.requestToSend
    const enLow = this.signals.rts && !this.signals.dtr
    if (this.enLow && !enLow) {
      this.boot()
    }
    this.enLow = enLow
  }

  private boot() {
    this.boots += 1
    if (this.options.nativeUsb) {
      this.staleHandle = true
    }
    this.state = 'app'
    this.rx = []
    this.lineBuffer = ''
    // Boot output at the console default; unreadable at any other rate.
    if (this.baudRate === AT_BAUD) {
      queueMicrotask(() => this.sendText('\r\nbootInit()\r\nWait for AT commands .'))
    }
  }

  private send(bytes: Uint8Array) {
    if (this.readableClosed) return
    try {
      this.controller?.enqueue(bytes)
    } catch {
      // Stream closed by the host.
    }
  }

  private sendText(text: string) {
    // The ESP-IDF console expands every "\n" to "\r\n" on top of the firmware's own "\r\n".
    this.send(this.encoder.encode(text.replace(/\n/g, '\r\n')))
  }

  private onHostBytes(chunk: Uint8Array) {
    if (this.staleHandle) {
      // The device this handle belongs to is gone; the host's bytes go nowhere.
      this.droppedWrites += chunk.length
      return
    }
    if (this.state === 'app') {
      if (this.baudRate !== AT_BAUD) {
        this.garbageBytes += chunk.length
        return
      }
      this.lineBuffer += this.decoder.decode(chunk, { stream: true })
      let index: number
      while ((index = this.lineBuffer.search(/[\r\n]/)) >= 0) {
        const line = this.lineBuffer.slice(0, index).trim()
        this.lineBuffer = this.lineBuffer.slice(index + 1)
        if (line) this.handleAtLine(line)
      }
      return
    }
    if (this.baudRate !== (this.options.usbConsole ? AT_BAUD : BRIDGE_BAUD)) {
      this.garbageBytes += chunk.length
      return
    }
    for (const byte of chunk) {
      this.onRomByte(byte)
    }
  }

  private handleAtLine(line: string) {
    this.atLines.push(line)
    if (line === 'AT') {
      this.sendText('=> AT\r\n<= OK\r\n\r\n')
      return
    }
    this.sendText(`>> ${line}\r\n`)
    if (line === 'AT+RADARBOOT=BRIDGE' || line === 'AT+RADARBOOT=AUTO') {
      if (line.endsWith('AUTO')) {
        this.sendText('<< RADARBOOT=AUTO: bridge-on-boot enabled; rebooting\r\n\r\n')
      }
      this.sendText(
        '<< RADARBOOT rx 0: CC\r\n<< RADARBOOT: ROM ACK 0xCC (bootloader ready)\r\n' +
          '<< RADARBOOT bridge: forwarding console <-> radar UART. Reset ESP to exit.\r\n' +
          (this.options.usbConsole
            ? '<< RADARBOOT bridge: console is USB, baud unchanged\r\n\r\n'
            : `<< RADARBOOT bridge: console switching to ${BRIDGE_BAUD} baud\r\n\r\n`),
      )
      this.state = 'bridge'
      return
    }
    if (line === 'AT+RADARBOOT=OFF') {
      this.sendText('<< RADARBOOT=OFF: bridge flag cleared, SOP2 released, radar reset\r\n\r\n')
      return
    }
    if (line === 'AT+RST') {
      this.sendText('<< RST: Reboot device\r\n\r\n')
      return
    }
    this.sendText(`<< ? ${line}\r\n\r\n`)
  }

  private onRomByte(byte: number) {
    if (this.rx.length === 0) {
      if (byte === 0xaa) {
        this.rx.push(byte)
      } else if (byte === 0xcc && this.expectingClientAck) {
        this.expectingClientAck = false
      } else {
        this.strayBytes += 1
      }
      return
    }
    this.rx.push(byte)
    if (this.rx.length < 4) return
    const length = (this.rx[1] << 8) | this.rx[2]
    if (this.rx.length < 2 + length) return
    const expected = this.rx[3]
    const payload = this.rx.slice(4, 2 + length)
    this.rx = []
    const checksum = payload.reduce((sum, b) => (sum + b) & 0xff, 0)
    if (checksum !== expected) {
      this.nacks += 1
      this.send(Uint8Array.from([0x33]))
      return
    }
    this.handleRomCommand(payload)
  }

  /** Status of the last command, as TI's GET_STATUS reports it. */
  private lastStatus = 0x40

  private handleRomCommand(payload: number[]) {
    const op = payload[0]
    const ack = () => this.send(Uint8Array.from([0xcc]))
    const nack = () => {
      this.nacks += 1
      this.send(Uint8Array.from([0x33]))
    }
    const be32 = (at: number) =>
      ((payload[at] << 24) | (payload[at + 1] << 16) | (payload[at + 2] << 8) | payload[at + 3]) >>> 0
    switch (op) {
      case 0x20: // PING
        this.pings += 1
        this.lastStatus = 0x40
        ack()
        break
      case 0x23: {
        // GET_STATUS: ACK, then a status packet the host must acknowledge.
        ack()
        const code = this.lastStatus
        this.send(Uint8Array.from([0x00, 0x03, code, code]))
        this.expectingClientAck = true
        break
      }
      case 0x21: // START_DOWNLOAD
        if (this.options.failStart === 'nack') {
          nack()
          return
        }
        if (this.options.failStart === 'status') {
          this.lastStatus = 0x4b // RET_FLASH_FAIL-style code; file stays closed
          ack()
          return
        }
        this.startDownload = { size: be32(1), storage: be32(5), fileMeta: be32(9) }
        this.lastStatus = 0x40
        ack()
        break
      case 0x24: // SEND_DATA
        this.packetSizes.push(payload.length - 1)
        this.received.push(...payload.slice(1))
        this.lastStatus = 0x40
        ack()
        break
      case 0x22: // FILE_CLOSE
        this.fileClosed = true
        this.lastStatus = 0x40
        ack()
        break
      default:
        nack()
    }
  }
}

type Run = {
  ok: boolean
  board: FakeBoard
  lines: string[]
  progress: RadarFlashProgress[]
}

const makeImage = (size: number): Uint8Array => {
  const image = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) image[i] = (i * 7 + 3) & 0xff
  return image
}

const run = async (
  board: FakeBoard,
  overrides: Partial<Parameters<typeof flashRadarImage>[0]> = {},
): Promise<Run> => {
  const lines: string[] = []
  const progress: RadarFlashProgress[] = []
  const logger: RadarFlashLogger = {
    onDeviceData: () => {},
    onStatus: (line) => lines.push(line),
    onWarn: (line) => lines.push(`[WARN] ${line}`),
    onError: (line) => lines.push(`[ERROR] ${line}`),
  }
  const ok = await flashRadarImage({
    port: board as unknown as SerialPort,
    image: makeImage(1000),
    imageName: 'vital_1_0_demo-TEST-1000.bin',
    route: 'auto',
    logger,
    onProgress: (p) => progress.push(p),
    ...overrides,
  })
  return { ok, board, lines, progress }
}

describe('flashRadarImage', () => {
  it('delivers the image byte for byte through the bridge and cleans up', async () => {
    const image = makeImage(1000)
    const { ok, board, lines, progress } = await run(new FakeBoard(), { image })

    expect(ok).toBe(true)
    expect(Uint8Array.from(board.received)).toEqual(image)
    expect(board.startDownload).toEqual({ size: 1000, storage: 2, fileMeta: 4 })
    expect(board.packetSizes).toEqual([240, 240, 240, 240, 40])
    expect(board.fileClosed).toBe(true)
    expect(board.pings).toBe(1)
    expect(board.nacks).toBe(0)
    expect(board.strayBytes).toBe(0)
    // Nothing was written at the wrong baud on either side of the switch.
    expect(board.garbageBytes).toBe(0)
    // Armed with BRIDGE (bodge wire), never AUTO.
    expect(board.atLines).toContain('AT+RADARBOOT=BRIDGE')
    expect(board.atLines).not.toContain('AT+RADARBOOT=AUTO')
    // Cleanup released the radar and rebooted the ESP, back at the console baud.
    expect(board.atLines.slice(-2)).toEqual(['AT+RADARBOOT=OFF', 'AT+RST'])
    expect(board.baudRate).toBe(AT_BAUD)
    expect(board.state).toBe('app')
    expect(lines).toContain('FLASH COMPLETED THROUGH ESP BRIDGE')
    const last = progress.filter((p) => p.phase === 'download').at(-1)
    expect(last?.sent).toBe(1000)
    expect(progress.at(-1)?.phase).toBe('done')
  }, 15_000)

  it('does not reset the ESP while switching the console baud', async () => {
    const { ok, board } = await run(new FakeBoard())
    expect(ok).toBe(true)
    // One boot to reach the AT window, one in cleanup. A third would mean the
    // reopen at 921600 dropped DTR before RTS and knocked the bridge down.
    expect(board.boots).toBe(2)
  }, 15_000)

  it('uses the persistent bridge and waits for the operator on the buttons route', async () => {
    let askedAt: number | null = null
    let pingsWhenAsked = -1
    const board = new FakeBoard()
    const { ok } = await run(board, {
      route: 'buttons',
      waitForButtons: async () => {
        askedAt = Date.now()
        pingsWhenAsked = board.pings
      },
    })
    expect(ok).toBe(true)
    expect(askedAt).not.toBeNull()
    expect(board.atLines).toContain('AT+RADARBOOT=AUTO')
    // The prompt comes after the bridge is up and before any ROM traffic.
    expect(pingsWhenAsked).toBe(0)
    expect(board.pings).toBe(1)
    expect(board.fileClosed).toBe(true)
  }, 20_000)

  it('refuses the buttons route without an operator step', async () => {
    const board = new FakeBoard()
    const { ok, lines } = await run(board, { route: 'buttons' })
    expect(ok).toBe(false)
    expect(board.atLines).toEqual([])
    expect(lines.some((l) => /operator confirmation/.test(l))).toBe(true)
  })

  it('stops on a rejected START_DOWNLOAD and still cleans up', async () => {
    const { ok, board, lines } = await run(new FakeBoard({ failStart: 'nack' }))
    expect(ok).toBe(false)
    expect(board.received).toEqual([])
    expect(board.fileClosed).toBe(false)
    expect(lines.some((l) => /START_DOWNLOAD rejected/.test(l))).toBe(true)
    expect(board.atLines.slice(-2)).toEqual(['AT+RADARBOOT=OFF', 'AT+RST'])
    expect(board.state).toBe('app')
  }, 15_000)

  it('treats a non-success status as a rejection', async () => {
    const { ok, board } = await run(new FakeBoard({ failStart: 'status' }))
    expect(ok).toBe(false)
    expect(board.received).toEqual([])
    expect(board.atLines.slice(-2)).toEqual(['AT+RADARBOOT=OFF', 'AT+RST'])
  }, 15_000)

  it('cancels mid-download without closing the file, then cleans up', async () => {
    const board = new FakeBoard()
    let cancel = false
    const { ok, lines } = await run(board, {
      image: makeImage(240 * 20),
      shouldCancel: () => cancel,
      onProgress: (p) => {
        if (p.phase === 'download' && p.sent >= 240 * 3) cancel = true
      },
    })
    expect(ok).toBe(false)
    expect(board.received.length).toBeGreaterThanOrEqual(240 * 3)
    expect(board.received.length).toBeLessThan(240 * 20)
    expect(board.fileClosed).toBe(false)
    expect(lines).toContain('[WARN] Cancelled by user.')
    expect(board.atLines.slice(-2)).toEqual(['AT+RADARBOOT=OFF', 'AT+RST'])
  }, 15_000)

  it('keeps the console rate when the firmware says the console is USB', async () => {
    const image = makeImage(1000)
    const board = new FakeBoard({ usbConsole: true })
    const { ok, lines } = await run(board, { image })

    expect(ok).toBe(true)
    expect(Uint8Array.from(board.received)).toEqual(image)
    expect(board.fileClosed).toBe(true)
    // Switching to 921600 here would have sent every byte at a rate the board
    // is not listening on.
    expect(board.garbageBytes).toBe(0)
    expect(board.baudRate).toBe(AT_BAUD)
    expect(lines.some((l) => /console is USB/.test(l))).toBe(true)
    expect(lines.some((l) => /raised to/.test(l))).toBe(false)
  }, 15_000)

  it('reacquires the port after the reset on a board whose USB is the ESP32 itself', async () => {
    const board = new FakeBoard({ nativeUsb: true, usbConsole: true })
    const { ok, lines } = await run(board, { image: makeImage(500) })

    expect(ok).toBe(true)
    expect(board.fileClosed).toBe(true)
    // Everything that mattered arrived: the AT window was answered and the ROM
    // took the image, which is only possible on a handle opened after the reset.
    expect(board.atLines).toContain('AT+RADARBOOT=BRIDGE')
    expect(board.received.length).toBe(500)
    expect(lines.some((l) => /re-enumerate/.test(l))).toBe(true)
    // The cleanup resets the board too, so it needs the same treatment. Without
    // it RADARBRIDGE stays set and the board boots into the bridge for good.
    expect(board.atLines.slice(-2)).toEqual(['AT+RADARBOOT=OFF', 'AT+RST'])
  }, 20_000)

  it('leaves a bridge-chip port alone across the reset', async () => {
    const board = new FakeBoard()
    const { ok, lines } = await run(board)

    expect(ok).toBe(true)
    expect(board.droppedWrites).toBe(0)
    // A CH343 stays on the bus while the ESP32 reboots, so the handle is still
    // good; closing and reopening it here would only risk losing the streams.
    expect(lines.some((l) => /re-enumerate/.test(l))).toBe(false)
  }, 15_000)

  it('refuses a known-bad image before touching the port', async () => {
    const board = new FakeBoard()
    const { ok, lines } = await run(board, {
      imageName: 'BROKEN-do-not-flash-vital_1_0_demo-242B420C-621124.bin',
    })
    expect(ok).toBe(false)
    expect(board.boots).toBe(0)
    expect(board.atLines).toEqual([])
    expect(lines.some((l) => /Refusing to flash/.test(l))).toBe(true)
  })
})

describe('isBrokenImageName', () => {
  it('matches the bench naming convention only', () => {
    expect(isBrokenImageName('BROKEN-do-not-flash-vital_1_0_demo-242B420C-621124.bin')).toBe(true)
    expect(isBrokenImageName('vital_1_0_demo-BA9283A7-621508.bin')).toBe(false)
    expect(isBrokenImageName('wall_1_0_demo-5B255C52-602756.bin')).toBe(false)
  })
})
