import type { ExchangeId, Position, AccountBalance, SpotBalance, ExchangeResponse, AddressQuery } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId, isValidEvmAddress } from '../utils'

const HYPERLIQUID_API_BASE = 'https://api.hyperliquid.xyz'

interface HyperliquidAssetPosition {
  position: {
    coin: string
    szi: string
    leverage: { type: string; value: number }
    entryPx: string
    positionValue: string
    unrealizedPnl: string
    returnOnEquity: string
    liquidationPx: string | null
    marginUsed: string
    maxTradeSzs: [string, string]
    cumFunding: { allTime: string; sinceOpen: string; sinceChange: string }
  }
  type: string
}

interface HyperliquidClearinghouseState {
  assetPositions: HyperliquidAssetPosition[]
  crossMarginSummary: {
    accountValue: string
    totalNtlPos: string
    totalRawUsd: string
    totalMarginUsed: string
  }
  marginSummary: {
    accountValue: string
    totalNtlPos: string
    totalRawUsd: string
    totalMarginUsed: string
  }
  crossMaintenanceMarginUsed: string
  withdrawable: string
}

interface HyperliquidSpotBalance {
  coin: string
  total: string
  hold: string
  entryNtl: string
  token: number
}

interface HyperliquidSpotClearinghouseState {
  balances: HyperliquidSpotBalance[]
}

interface HyperliquidPerpDexMeta {
  name: string
  fullName: string
}

interface HyperliquidOpenOrder {
  coin: string
  oid: number
  side: string
  sz: string
  limitPx: string
  orderType?: string
  reduceOnly: boolean
  triggerCondition?: string
  triggerPx?: string
  isTrigger?: boolean
  isPositionTpsl?: boolean
  origSz?: string
  timestamp?: number
}

export class HyperliquidClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'hyperliquid'

  private perpDexCache?: { names: (string | undefined)[]; expiresAt: number }
  private static readonly PERP_DEX_TTL_MS = 5 * 60 * 1000

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${HYPERLIQUID_API_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Hyperliquid API error: ${response.status} - ${errorText}`)
    }

    return response.json()
  }

  private async getDexQueryNames(): Promise<(string | undefined)[]> {
    const now = Date.now()
    if (this.perpDexCache && this.perpDexCache.expiresAt > now) {
      return this.perpDexCache.names
    }
    try {
      const dexs = await this.post<(HyperliquidPerpDexMeta | null)[]>({ type: 'perpDexs' })
      const names: (string | undefined)[] = [undefined]
      for (const d of dexs) {
        if (d && d.name) names.push(d.name)
      }
      this.perpDexCache = { names, expiresAt: now + HyperliquidClient.PERP_DEX_TTL_MS }
      return names
    } catch {
      return [undefined]
    }
  }

  private async fetchClearinghouseState(
    address: string,
    dex?: string
  ): Promise<HyperliquidClearinghouseState | null> {
    try {
      const body: Record<string, unknown> = { type: 'clearinghouseState', user: address }
      if (dex) body.dex = dex
      return await this.post<HyperliquidClearinghouseState>(body)
    } catch {
      return null
    }
  }

  async getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      const state = await this.post<HyperliquidClearinghouseState>({
        type: 'clearinghouseState',
        user: address,
      })

      let frontendOrders: HyperliquidOpenOrder[] = []
      try {
        frontendOrders = await this.post<HyperliquidOpenOrder[]>({
          type: 'frontendOpenOrders',
          user: address,
        })
      } catch {
        // silently ignore order fetch failures
      }

      const slTpMap = this.extractSlTpFromOrders(frontendOrders)
      const positions = this.transformPositions(state.assetPositions, slTpMap)

      return this.createSuccessResponse(positions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getSpotBalances(query?: AddressQuery): Promise<ExchangeResponse<SpotBalance[]>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      const state = await this.post<HyperliquidSpotClearinghouseState>({
        type: 'spotClearinghouseState',
        user: address,
      })

      const balances = state.balances || []

      const spotBalances: SpotBalance[] = balances
        .filter((b) => parseFloat(b.total) !== 0)
        .map((b) => ({
          symbol: b.coin,
          balance: b.total,
          lockedBalance: b.hold || '0',
        }))

      return this.createSuccessResponse(spotBalances)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch spot balances'
      )
    }
  }

  async getAccountBalance(query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    const address = query?.address
    if (!address || !isValidEvmAddress(address)) {
      return this.createErrorResponse('Invalid or missing EVM address')
    }

    try {
      const dexNames = await this.getDexQueryNames()
      const states = await Promise.all(
        dexNames.map((dex) => this.fetchClearinghouseState(address, dex))
      )

      let totalEquity = 0
      let availableBalance = 0
      let usedMargin = 0
      let unrealizedPnl = 0
      let anySuccess = false

      for (const state of states) {
        if (!state) continue
        anySuccess = true
        // marginSummary = 전체(isolated 포함). crossMarginSummary는 isolated dex에서 0이라 쓰지 않음.
        const ms = state.marginSummary
        totalEquity += parseFloat(ms.accountValue) || 0
        usedMargin += parseFloat(ms.totalMarginUsed) || 0
        availableBalance += parseFloat(state.withdrawable || '0') || 0
        for (const ap of state.assetPositions) {
          unrealizedPnl += parseFloat(ap.position.unrealizedPnl) || 0
        }
      }

      if (!anySuccess) {
        return this.createErrorResponse('Failed to fetch account balance')
      }

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity,
        availableBalance,
        usedMargin,
        unrealizedPnl,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private extractSlTpFromOrders(
    orders: HyperliquidOpenOrder[]
  ): Map<string, { stopLoss: number | null; takeProfit: number | null }> {
    const slTpMap = new Map<string, { stopLoss: number | null; takeProfit: number | null }>()

    const tpslOrders = orders.filter(
      (o) => o.isTrigger && o.isPositionTpsl && o.triggerPx
    )

    for (const order of tpslOrders) {
      const coin = order.coin
      const triggerPrice = parseFloat(order.triggerPx!)

      if (isNaN(triggerPrice) || triggerPrice === 0) continue

      if (!slTpMap.has(coin)) {
        slTpMap.set(coin, { stopLoss: null, takeProfit: null })
      }

      const slTp = slTpMap.get(coin)!
      const orderType = order.orderType?.toLowerCase() || ''

      if (orderType.includes('stop') && !orderType.includes('take')) {
        slTp.stopLoss = triggerPrice
      } else if (orderType.includes('take profit') || orderType.includes('tp')) {
        slTp.takeProfit = triggerPrice
      } else {
        const triggerCond = order.triggerCondition?.toLowerCase() || ''
        if (triggerCond.includes('below')) {
          slTp.stopLoss = triggerPrice
        } else if (triggerCond.includes('above')) {
          slTp.takeProfit = triggerPrice
        }
      }
    }

    return slTpMap
  }

  private transformPositions(
    assetPositions: HyperliquidAssetPosition[],
    slTpMap: Map<string, { stopLoss: number | null; takeProfit: number | null }>
  ): Position[] {
    return assetPositions
      .filter((ap) => {
        const szi = parseFloat(ap.position.szi)
        return szi !== 0 && !isNaN(szi)
      })
      .map((ap) => {
        const pos = ap.position
        const szi = parseFloat(pos.szi)
        const size = Math.abs(szi)
        const entryPrice = parseFloat(pos.entryPx)
        const positionValue = Math.abs(parseFloat(pos.positionValue))
        const unrealizedPnl = parseFloat(pos.unrealizedPnl)
        const side = szi > 0 ? 'long' : 'short'
        const leverage = pos.leverage?.value || 1
        const margin = parseFloat(pos.marginUsed) || positionValue / leverage
        const unrealizedPnlPercent = parseFloat(pos.returnOnEquity) * 100 || 0
        const markPrice = size > 0 ? positionValue / size : entryPrice
        const liquidationPrice = pos.liquidationPx ? parseFloat(pos.liquidationPx) : null
        const baseAsset = pos.coin
        const market = `${baseAsset}-PERP`
        const slTp = slTpMap.get(baseAsset)

        return {
          id: generatePositionId(this.exchangeId, market, side),
          exchange: this.exchangeId,
          market,
          baseAsset,
          side,
          size,
          sizeUsd: positionValue,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          leverage,
          liquidationPrice,
          stopLoss: slTp?.stopLoss || null,
          takeProfit: slTp?.takeProfit || null,
          margin,
          marginRatio: null,
          createdAt: null,
          updatedAt: new Date(),
        }
      })
  }
}
