import path from 'path'
import os from 'os'
import fs from 'fs'

function getSignerFilename(): string {
  const platform = os.platform()
  const arch = os.arch()

  if (platform === 'darwin' && arch === 'arm64') {
    return 'lighter-signer-darwin-arm64.dylib'
  } else if (platform === 'linux' && arch === 'x64') {
    return 'lighter-signer-linux-amd64.so'
  } else if (platform === 'linux' && arch === 'arm64') {
    return 'lighter-signer-linux-arm64.so'
  } else if (platform === 'win32' && arch === 'x64') {
    return 'lighter-signer-windows-amd64.dll'
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`)
}

function getSignerPath(): string {
  const filename = getSignerFilename()

  // Search candidate directories:
  // 1. __dirname itself (dev mode: src/signers/)
  // 2. ../src/signers relative to __dirname (bundled mode: running from dist/)
  const candidates = [
    path.join(__dirname, filename),
    path.join(__dirname, '..', 'src', 'signers', filename),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Lighter signer binary not found: ${filename}. Searched: ${candidates.join(', ')}`
  )
}

// Singleton state for the loaded library and bound functions
let initialized = false
let clientInitialized = false
let CreateClientFn: any
let CreateAuthTokenFn: any

function ensureInitialized(): void {
  if (initialized) return

  let koffi: any
  try {
    koffi = require('koffi')
  } catch {
    throw new Error(
      'koffi is required for native Lighter token generation. Install it with: npm install koffi'
    )
  }

  const StrOrErr = koffi.struct('StrOrErr', {
    str: 'char*',
    err: 'char*',
  })

  const signerPath = getSignerPath()
  const lib = koffi.load(signerPath)

  CreateClientFn = lib.func('CreateClient', 'char*', [
    'char*',    // url
    'char*',    // privateKey
    'int',      // chainId
    'int',      // apiKeyIndex
    'longlong', // accountIndex
  ])

  CreateAuthTokenFn = lib.func('CreateAuthToken', StrOrErr, [
    'longlong', // deadline
    'int',      // apiKeyIndex
    'longlong', // accountIndex
  ])

  initialized = true
}

/**
 * Initialize the Go client and generate an auth token.
 * Called once to set up credentials.
 */
export function createLighterAuthToken(
  privateKey: string,
  accountIndex: number,
  apiKeyIndex: number,
  deadlineSeconds: number = 3600
): string {
  ensureInitialized()

  // Initialize client with private key
  CreateClientFn(
    'https://mainnet.zklighter.elliot.ai',
    privateKey,
    300,
    apiKeyIndex,
    accountIndex
  )
  clientInitialized = true

  // Generate token
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds
  const result = CreateAuthTokenFn(deadline, apiKeyIndex, accountIndex)

  if (result.err) {
    throw new Error(`Lighter token generation failed: ${result.err}`)
  }

  return result.str!
}

/**
 * Generate a fresh auth token using the already-initialized Go client.
 * Must call createLighterAuthToken() first to initialize credentials.
 */
export function refreshLighterAuthToken(
  apiKeyIndex: number,
  accountIndex: number,
  deadlineSeconds: number = 3600
): string {
  ensureInitialized()

  if (!clientInitialized) {
    throw new Error('Must call createLighterAuthToken() first to initialize the client')
  }

  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds
  const result = CreateAuthTokenFn(deadline, apiKeyIndex, accountIndex)

  if (result.err) {
    throw new Error(`Lighter token refresh failed: ${result.err}`)
  }

  return result.str!
}
