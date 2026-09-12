type SerialSession = {
  serialPort: SerialPort | null
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  isReading: boolean
}

type ReadLoopHandlers = {
  onChunk: (chunk: Uint8Array) => void
  onError: (errorMessage: string) => void
}

type SerialConnectOptions = {
  serial: NonNullable<Navigator['serial']>
  settings: {
    baudRate: number
    dataBits?: 7 | 8
    stopBits?: 1 | 2
    parity?: 'none' | 'even' | 'odd'
    flowControl?: 'none' | 'hardware'
    bufferSize?: number
  }
}

/** Espressif's vendor id: the USB device is the ESP32-S3 itself, not a bridge chip. */
const ESPRESSIF_USB_VENDOR_ID = 0x303a

/**
 * True when this port is provided by the ESP32-S3's own USB peripheral, so
 * resetting the chip takes the USB device off the bus.
 */
export const isNativeEspUsbPort = (port: SerialPort): boolean =>
  port.getInfo?.().usbVendorId === ESPRESSIF_USB_VENDOR_ID

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Re-acquire a port after the board was reset.
 *
 * On a bridge-chip board (CH343, CP210x) the USB device belongs to the bridge
 * and survives the reset, so the existing handle stays valid and is kept — that
 * path is unchanged.
 *
 * On a board whose USB device is the ESP32-S3 itself, the reset removes that
 * device and a new one appears a moment later. A handle held across the change
 * keeps delivering the board's boot log while every write times out, so the
 * session looks healthy and no command ever arrives. Reopening is not enough on
 * its own: the chip takes a moment to actually drop off the bus, so an
 * immediate reopen grabs the dying instance and lands in the same state. Wait
 * for the device to be announced again, then open.
 */
export const reacquirePortAfterReset = async (
  port: SerialPort,
  baudRate: number,
  options: { onStatus?: (line: string) => void; settleMs?: number } = {},
): Promise<void> => {
  const { onStatus, settleMs = 2500 } = options
  if (!isNativeEspUsbPort(port)) {
    return
  }
  onStatus?.('Native ESP32 USB port: waiting for the device to re-enumerate...')

  const target = navigator.serial as unknown as EventTarget | undefined
  let announced = false
  const onConnect = () => {
    announced = true
  }
  target?.addEventListener?.('connect', onConnect)

  try {
    await port.close()
  } catch {
    // Already closed, or the device went away mid-close.
  }

  // Give the chip time to leave the bus before believing anything we see.
  const settleDeadline = Date.now() + settleMs
  while (Date.now() < settleDeadline && !announced) {
    await sleep(100)
  }
  target?.removeEventListener?.('connect', onConnect)

  const openDeadline = Date.now() + 10_000
  let lastError = 'unknown error'
  while (Date.now() < openDeadline) {
    try {
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' })
      if (typeof port.setSignals === 'function') {
        await port.setSignals({ requestToSend: false })
        await port.setSignals({ dataTerminalReady: false })
      }
      onStatus?.('Port reacquired after the reset.')
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await sleep(150)
    }
  }
  throw new Error(`Port did not come back after the reset: ${lastError}`)
}

export const connectSerialSession = async (
  session: SerialSession,
  options: SerialConnectOptions,
) => {
  const port = await options.serial.requestPort()
  await port.open({
    baudRate: options.settings.baudRate,
    dataBits: options.settings.dataBits,
    stopBits: options.settings.stopBits,
    parity: options.settings.parity,
    flowControl: options.settings.flowControl,
    bufferSize: options.settings.bufferSize,
  })

  session.serialPort = port
  session.isReading = false
  session.reader = null

  return port
}

export const disconnectSerialSession = async (session: SerialSession) => {
  session.isReading = false

  try {
    await session.reader?.cancel()
  } catch {
    // Ignore reader cancel errors while disconnecting.
  }

  try {
    await session.serialPort?.close()
  } catch {
    // Ignore close errors while disconnecting.
  }

  session.reader = null
  session.serialPort = null
}

export const runSerialReadLoop = async (
  session: SerialSession,
  handlers: ReadLoopHandlers,
) => {
  if (!session.serialPort?.readable) {
    return
  }

  session.isReading = true

  try {
    while (session.isReading && session.serialPort?.readable) {
      const reader = session.serialPort.readable.getReader()
      session.reader = reader

      try {
        while (session.isReading) {
          const { value, done } = await reader.read()
          if (done) {
            break
          }
          if (value) {
            handlers.onChunk(value)
          }
        }
      } finally {
        reader.releaseLock()
        if (session.reader === reader) {
          session.reader = null
        }
      }
    }
  } catch (error) {
    handlers.onError(error instanceof Error ? error.message : 'unknown read error')
  } finally {
    session.isReading = false
  }
}

export const writeSerialBytes = async (session: SerialSession, bytes: Uint8Array) => {
  if (!session.serialPort?.writable) {
    throw new Error('serial port is not writable')
  }

  const writer = session.serialPort.writable.getWriter()
  try {
    await writer.write(bytes)
  } finally {
    writer.releaseLock()
  }
}

export const writeSerialText = async (
  session: SerialSession,
  payload: string,
  encoder: TextEncoder,
) => {
  await writeSerialBytes(session, encoder.encode(payload))
}
