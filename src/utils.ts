import type { ExchangeId, PositionSide } from './types'

export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

export function isValidSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
}

export function extractBaseAsset(market: string): string {
  if (market.includes('/')) return market.split('/')[0]
  if (market.includes('-')) return market.split('-')[0]
  if (market.includes('_')) return market.split('_')[0]
  return market
}

export function generatePositionId(exchange: ExchangeId, market: string, side: PositionSide): string {
  return `${exchange}_${market}_${side}`
}
