/**
 * Client identity: the per-process instance id and the hashed machine
 * fingerprint the official DeepAI Code client presents upstream.
 *
 * The raw hardware UUID never leaves this module: only its SHA-256 digest is
 * ever placed on a request, and the digest itself is cached on disk so the
 * plugin does not shell out on every start.
 *
 * @module dsh-deepaicode-auto/identity
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Environment variable that overrides the detected hardware identity. */
export const MACHINE_ID_ENV = 'DEEPAI_MACHINE_ID'

/** 32 hex characters, generated once per process. */
export function createInstanceId() {
  return randomBytes(16).toString('hex')
}

/**
 * Digest one raw machine identity.
 * @param {string} raw - the raw hardware identity or the override value.
 * @returns {string} its lower-case SHA-256 hex digest.
 */
export function digestMachineId(raw) {
  return createHash('sha256').update(raw.trim().toLowerCase(), 'utf8').digest('hex')
}

/**
 * Resolve the default on-disk cache location for the machine digest.
 * @returns {string} absolute path of the cache file.
 */
export function defaultCachePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'deepaicode', 'machine.json')
}

/**
 * Read the operating system's hardware identity.
 * @returns {Promise<string | null>} the raw identity, or null when it cannot be read.
 */
async function detectRawMachineId() {
  const os = platform()
  try {
    if (os === 'win32') {
      // MachineGuid survives hardware changes far better than the SMBIOS UUID
      // some OEM images leave blank, so it is the primary source.
      try {
        const { stdout } = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { timeout: 5000, windowsHide: true })
        const match = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(stdout)
        if (match?.[1]) return match[1]
      } catch {
        // Fall through to the SMBIOS product UUID.
      }
      try {
        const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], { timeout: 8000, windowsHide: true })
        const value = stdout.trim()
        if (value.length > 0 && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) return value
      } catch {
        // Fall through to the synthetic identity below.
      }
      return null
    }
    if (os === 'darwin') {
      const { stdout } = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000 })
      const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)
      return match?.[1] ?? null
    }
    const text = await readFile('/etc/machine-id', 'utf8')
    const value = text.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * Build a stable pseudo-identity for hosts whose hardware id cannot be read.
 * @returns {string} a deterministic string derived from host facts.
 */
function syntheticMachineId() {
  return `synthetic:${platform()}:${process.arch}`
}

/**
 * Resolve the `X-DeepAI-Code-Machine` value, preferring an explicit override,
 * then the cached digest, then a fresh detection.
 * @param {object} [options] - resolution options.
 * @param {string} [options.override] - configured override value.
 * @param {string} [options.cachePath] - cache file location.
 * @param {{warn: (...args: unknown[]) => void}} [options.logger] - sink for detection failures.
 * @returns {Promise<string>} the hex digest to send upstream.
 */
export async function resolveMachineDigest(options = {}) {
  const explicit = options.override ?? process.env[MACHINE_ID_ENV]
  if (typeof explicit === 'string' && explicit.trim().length > 0) return digestMachineId(explicit)

  const cachePath = options.cachePath ?? defaultCachePath()
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    if (cached && typeof cached.machineDigest === 'string' && /^[0-9a-f]{64}$/.test(cached.machineDigest)) {
      return cached.machineDigest
    }
  } catch {
    // No usable cache: detect and write one.
  }

  const raw = await detectRawMachineId()
  const digest = digestMachineId(raw ?? syntheticMachineId())
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify({ machineDigest: digest, source: raw === null ? 'synthetic' : 'hardware' }, null, 2), { mode: 0o600 })
  } catch (error) {
    options.logger?.warn('deepaicode: could not cache the machine fingerprint', error)
  }
  return digest
}
