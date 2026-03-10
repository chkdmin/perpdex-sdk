import { describe, it, expect } from 'vitest'
import { isValidEvmAddress, isValidSolanaAddress, extractBaseAsset, generatePositionId } from '../utils'

describe('isValidEvmAddress', () => {
  it('accepts valid EVM address', () => {
    expect(isValidEvmAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(true)
  })
  it('rejects invalid EVM address', () => {
    expect(isValidEvmAddress('not-an-address')).toBe(false)
    expect(isValidEvmAddress('')).toBe(false)
  })
})

describe('isValidSolanaAddress', () => {
  it('accepts valid Solana address', () => {
    expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true)
  })
  it('rejects invalid Solana address', () => {
    expect(isValidSolanaAddress('0xinvalid')).toBe(false)
  })
})

describe('extractBaseAsset', () => {
  it('extracts from BTC-PERP format', () => {
    expect(extractBaseAsset('BTC-PERP')).toBe('BTC')
  })
  it('extracts from ETH/USDT:USDT format', () => {
    expect(extractBaseAsset('ETH/USDT:USDT')).toBe('ETH')
  })
  it('extracts from BTC_USDT format', () => {
    expect(extractBaseAsset('BTC_USDT')).toBe('BTC')
  })
})

describe('generatePositionId', () => {
  it('generates correct id', () => {
    expect(generatePositionId('lighter', 'BTC-PERP', 'long')).toBe('lighter_BTC-PERP_long')
  })
})
