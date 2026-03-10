import { describe, it, expect } from 'vitest'
import { mapCcxtPosition } from '../base/ccxt-adapter'

describe('mapCcxtPosition', () => {
  it('maps CCXT position to unified Position', () => {
    const ccxtPosition = {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      contracts: 0.5,
      contractSize: 1,
      notional: 25000,
      entryPrice: 50000,
      markPrice: 51000,
      unrealizedPnl: 500,
      percentage: 10,
      leverage: 5,
      liquidationPrice: 40000,
      stopLossPrice: 48000,
      takeProfitPrice: 55000,
      initialMargin: 5000,
      marginRatio: 0.2,
      timestamp: 1710000000000,
    }

    const result = mapCcxtPosition(ccxtPosition, 'hyperliquid')
    expect(result.exchange).toBe('hyperliquid')
    expect(result.market).toBe('BTC/USDT:USDT')
    expect(result.baseAsset).toBe('BTC')
    expect(result.side).toBe('long')
    expect(result.size).toBe(0.5)
    expect(result.sizeUsd).toBe(25000)
    expect(result.entryPrice).toBe(50000)
    expect(result.markPrice).toBe(51000)
    expect(result.unrealizedPnl).toBe(500)
    expect(result.unrealizedPnlPercent).toBe(10)
    expect(result.leverage).toBe(5)
    expect(result.liquidationPrice).toBe(40000)
    expect(result.stopLoss).toBe(48000)
    expect(result.takeProfit).toBe(55000)
    expect(result.margin).toBe(5000)
    expect(result.marginRatio).toBe(0.2)
    expect(result.createdAt).toBeNull()
    expect(result.updatedAt).toBeInstanceOf(Date)
    expect(result.id).toBe('hyperliquid_BTC/USDT:USDT_long')
  })

  it('handles null/undefined fields gracefully', () => {
    const minimal = {
      symbol: 'ETH/USDT:USDT',
      side: 'short',
      contracts: 1,
      contractSize: 1,
    }

    const result = mapCcxtPosition(minimal, 'lighter')
    expect(result.exchange).toBe('lighter')
    expect(result.side).toBe('short')
    expect(result.liquidationPrice).toBeNull()
    expect(result.stopLoss).toBeNull()
    expect(result.takeProfit).toBeNull()
  })
})
