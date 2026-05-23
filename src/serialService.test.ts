import { describe, expect, it, vi } from 'vitest'
import {
  connectSerialSession,
  disconnectSerialSession,
  writeSerialBytes,
  writeSerialText,
} from './serialService'

type TestSession = Parameters<typeof connectSerialSession>[0]

const createSession = (): TestSession => ({
  serialPort: null,
  reader: null,
  isReading: false,
})

describe('serialService', () => {
  it('connectSerialSession requests and opens a serial port', async () => {
    const session = createSession()
    const open = vi.fn().mockResolvedValue(undefined)
    const port = {
      open,
      close: vi.fn(),
      readable: null,
      writable: null,
    } as unknown as SerialPort

    const serial = {
      requestPort: vi.fn().mockResolvedValue(port),
    } as NonNullable<Navigator['serial']>

    const connectedPort = await connectSerialSession(session, {
      serial,
      settings: {
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 4096,
      },
    })

    expect(connectedPort).toBe(port)
    expect(serial.requestPort).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 4096,
    })
    expect(session.serialPort).toBe(port)
    expect(session.reader).toBeNull()
    expect(session.isReading).toBe(false)
  })

  it('disconnectSerialSession cancels active reader and closes port', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)

    const session: TestSession = {
      serialPort: {
        open: vi.fn(),
        close,
        readable: null,
        writable: null,
      } as unknown as SerialPort,
      reader: {
        cancel,
      } as unknown as ReadableStreamDefaultReader<Uint8Array>,
      isReading: true,
    }

    await disconnectSerialSession(session)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(session.isReading).toBe(false)
    expect(session.reader).toBeNull()
    expect(session.serialPort).toBeNull()
  })

  it('writeSerialBytes writes payload through writer and releases lock', async () => {
    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    }
    const session: TestSession = {
      serialPort: {
        open: vi.fn(),
        close: vi.fn(),
        readable: null,
        writable: {
          getWriter: () => writer,
        } as unknown as WritableStream<Uint8Array>,
      } as unknown as SerialPort,
      reader: null,
      isReading: false,
    }

    const payload = new Uint8Array([0xaa, 0xbb])
    await writeSerialBytes(session, payload)

    expect(writer.write).toHaveBeenCalledWith(payload)
    expect(writer.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('writeSerialText encodes text using the provided encoder', async () => {
    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    }
    const session: TestSession = {
      serialPort: {
        open: vi.fn(),
        close: vi.fn(),
        readable: null,
        writable: {
          getWriter: () => writer,
        } as unknown as WritableStream<Uint8Array>,
      } as unknown as SerialPort,
      reader: null,
      isReading: false,
    }

    await writeSerialText(session, 'AT+RST\r\n', new TextEncoder())

    const [encoded] = writer.write.mock.calls[0] as [Uint8Array]
    expect(new TextDecoder().decode(encoded)).toBe('AT+RST\r\n')
    expect(writer.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('writeSerialBytes throws when port is not writable', async () => {
    const session = createSession()
    await expect(writeSerialBytes(session, new Uint8Array([0x01]))).rejects.toThrow(
      'serial port is not writable',
    )
  })
})
