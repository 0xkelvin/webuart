import { describe, expect, it } from 'vitest'
import { CONFIG_AT_KEYS, applyConfig, parseJsonConfig } from './configService'

/**
 * A fake ESP32-S3 that reproduces gm_radar's at_cmd.c line-for-line:
 *
 *   at_session()  -> "=> AT"  then "<= OK"
 *   every line    -> ">> <line>"                (BEFORE parsing or storing)
 *   known key=val -> config_save_key(), then "<< KEY=<stored>"   (AFTER storing)
 *   unknown key   -> "<< ? KEY"
 *
 * The gap between the ">>" echo and the "<<" acknowledgement is the whole point:
 * a client that matches the echo reports success for writes that never landed.
 */
type DeviceOptions = {
  /** Keys the device refuses to acknowledge (simulates a dropped write). */
  silentKeys?: string[]
  /** Cap stored values at N chars (simulates a UART truncation). */
  truncateAt?: number
  /** Emit the bootInit() banner the client waits for. */
  emitBoot?: boolean
}

class FakeDevice {
  readonly stored = new Map<string, string>()
  private controller!: ReadableStreamDefaultController<Uint8Array>
  private rxLine = ''
  private encoder = new TextEncoder()
  private decoder = new TextDecoder()
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  signals: Array<Record<string, boolean>> = []
  private options: DeviceOptions

  constructor(options: DeviceOptions = {}) {
    this.options = options
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
        if (options.emitBoot !== false) {
          // Firmware prints this at the start of its ~2s AT window.
          queueMicrotask(() => this.send('\r\nbootInit()\r\nWait for AT commands .'))
        }
      },
    })
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.rxLine += this.decoder.decode(chunk, { stream: true })
        let index: number
        while ((index = this.rxLine.search(/[\r\n]/)) >= 0) {
          const line = this.rxLine.slice(0, index).trim()
          this.rxLine = this.rxLine.slice(index + 1)
          if (line) this.handleLine(line)
        }
      },
    })
  }

  private send(text: string) {
    try {
      this.controller.enqueue(this.encoder.encode(text))
    } catch {
      // Stream closed by the client's release path.
    }
  }

  private handleLine(line: string) {
    if (line === 'AT') {
      this.send('=> AT\r\n<= OK\r\n\r\n')
      return
    }
    // at_cmd.c echoes the raw line before it parses anything.
    this.send(`>> ${line}\r\n`)
    if (!line.startsWith('AT+')) {
      this.send(`? ${line}\r\n\r\n`)
      return
    }
    const body = line.slice(3)
    const eq = body.indexOf('=')
    const key = eq >= 0 ? body.slice(0, eq) : body
    const payload = eq >= 0 ? body.slice(eq + 1) : ''

    if (key === 'CONT') {
      this.send('<< CONT: Continue bootup sequence \r\n\r\n')
      return
    }
    if (key === 'VER') { this.send('<< VER=1.2.3\r\n\r\n'); return }
    if (key === 'MAC') { this.send('<< MAC=aabbccddeeff\r\n\r\n'); return }

    const known = [...CONFIG_AT_KEYS, 'CFGSOURCE'] as string[]
    if (!known.includes(key)) {
      this.send(`<< ? ${key}\r\n\r\n`)
      return
    }
    if (this.options.silentKeys?.includes(key)) {
      return // echoed, never acknowledged — the write silently vanishes
    }
    const value = this.options.truncateAt ? payload.slice(0, this.options.truncateAt) : payload
    this.stored.set(key, value)
    this.send(`<< ${key}=${value}\r\n\r\n`)
  }

  asPort(): SerialPort {
    return {
      readable: this.readable,
      writable: this.writable,
      open: async () => {},
      close: async () => {},
      setSignals: async (s: Record<string, boolean>) => { this.signals.push(s) },
    } as unknown as SerialPort
  }
}

const silentLogger = () => ({
  onDeviceData: () => {}, onStatus: () => {}, onWarn: () => {}, onError: () => {},
})

// The real config the user applies after flashing.
const RADARCONFIG =
  'sensorStop;flushCfg;dfeDataOutputMode 1;channelCfg 15 7 0;adcCfg 2 1;' +
  'profileCfg 0 60 30.00 25.00 59.10 723723 0 33 1 96 2950.00 2 1 36;' +
  'boundaryBox -5 5 0.1 10 -5 5;sensorPosition 1.0 0 0;' +
  'trackingCfg 1 4 800 5 45.73 191 55;sensorStart'

const wallMountConfig = {
  WIFISSID: 'GM', WIFIPWD: 'GaitMetrics', MQTTADD: '143.198.199.16',
  MQTTPRT: 1883, MQTTGRP: 'GMT', MQTTKL: 60,
  TYPE: 'WALL', REPORTINT: 1, RADARCONFIG,
}

const run = (device: FakeDevice, config: Record<string, unknown> = wallMountConfig) =>
  applyConfig({
    port: device.asPort(),
    config,
    configFilename: 'config_wallMount_aswelfarehome_common_version_0623.json',
    resetMode: 'none', // no reset: the fake device is already in its AT window
    endCommand: 'cont',
    logger: silentLogger(),
  })

describe('applyConfig against a gm_radar-behaving device', () => {
  it('stores every key, including the long RADARCONFIG, verbatim', async () => {
    const device = new FakeDevice()
    await expect(run(device)).resolves.toBe(true)

    expect(device.stored.get('WIFISSID')).toBe('GM')
    expect(device.stored.get('WIFIPWD')).toBe('GaitMetrics')
    expect(device.stored.get('MQTTADD')).toBe('143.198.199.16')
    expect(device.stored.get('MQTTPRT')).toBe('1883')  // number -> string
    expect(device.stored.get('MQTTKL')).toBe('60')
    expect(device.stored.get('TYPE')).toBe('WALL')
    expect(device.stored.get('REPORTINT')).toBe('1')
    expect(device.stored.get('RADARCONFIG')).toBe(RADARCONFIG)
  })

  it('sends the metadata keys the firmware prints on boot', async () => {
    const device = new FakeDevice()
    await run(device)
    expect(device.stored.get('CFGFILE')).toBe(
      'config_wallMount_aswelfarehome_common_version_0623.json',
    )
    expect(device.stored.get('CFGSOURCE')).toBe('AT')
    expect(device.stored.get('CFGTIME')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('REGRESSION: fails when a write is never acknowledged', async () => {
    // The device still echoes ">> AT+RADARCONFIG=..." — matching that echo is
    // what made every key report OK regardless of whether it was stored.
    const device = new FakeDevice({ silentKeys: ['RADARCONFIG'] })
    await expect(run(device)).resolves.toBe(false)
    expect(device.stored.has('RADARCONFIG')).toBe(false)
  }, 15_000) // waits out sendAtAssignment's 5s acknowledgement timeout

  it('REGRESSION: fails when the device stores a truncated value', async () => {
    const device = new FakeDevice({ truncateAt: 40 })
    await expect(run(device)).resolves.toBe(false)
    expect(device.stored.get('RADARCONFIG')).not.toBe(RADARCONFIG)
  })

  it('skips keys the firmware does not know, without failing the run', async () => {
    const device = new FakeDevice()
    await expect(run(device, { ...wallMountConfig, NOTAKEY: 'x' })).resolves.toBe(true)
    expect(device.stored.has('NOTAKEY')).toBe(false)
    expect(device.stored.get('TYPE')).toBe('WALL')
  })

})

describe('parseJsonConfig', () => {
  it('accepts the real wall-mount config file shape', () => {
    const result = parseJsonConfig(JSON.stringify(wallMountConfig))
    expect(result.ok).toBe(true)
  })
  it('rejects a JSON array', () => {
    expect(parseJsonConfig('[1,2]')).toMatchObject({ ok: false })
  })
})
