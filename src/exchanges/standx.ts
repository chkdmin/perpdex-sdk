import type { ExchangeId, Position, AccountBalance, ExchangeResponse, AddressQuery, StandXConfig } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId } from '../utils'

const STANDX_API_BASE = 'https://perps.standx.com'

interface StandXPosition {
  id: number
  symbol: string
  qty: string
  entry_price: string
  entry_value: string
  leverage: string
  margin_mode: string
  margin_asset: string
  holding_margin: string
  initial_margin: string
  required_margin: string
  mark_price: string
  liq_price: string
  maint_margin: string
  mmr: string
  position_value: string
  upnl: string
  realized_pnl: string
  status: string
  created_at: string
  updated_at: string
}

interface StandXBalance {
  isolated_balance: string
  isolated_upnl: string
  cross_balance: string
  cross_margin: string
  cross_upnl: string
  locked: string
  cross_available: string
  balance: string
  upnl: string
  equity: string
  pnl_freeze: string
}

interface StandXOrdersResponse {
  code: number
  message: string
  page_size: number
  result: StandXOrder[]
}

interface StandXOrder {
  id: number
  cl_ord_id: string
  symbol: string
  side: string
  order_type: string
  qty: string
  price: string
  time_in_force: string
  reduce_only: boolean
  status: string
  fill_qty: string
  fill_avg_price: string
  leverage: string
  position_id: number
  source: string
  condition?: {
    direction: string
    group: string
    trigger_price: string
  }
  created_at: string
  updated_at: string
}

export class StandXClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'standx'
  private baseUrl: string
  private jwtToken: string

  constructor(config: StandXConfig, baseUrl = STANDX_API_BASE) {
    super()
    this.baseUrl = baseUrl
    this.jwtToken = config.jwtToken
  }

  private async fetchWithAuth(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.jwtToken}`,
    }

    const response = await fetch(url, { method: 'GET', headers })

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `StandX authentication failed (${response.status}). JWT token may be expired.`
      )
    }

    return response
  }

  private extractBaseAsset(symbol: string): string {
    const separatorMatch = symbol.match(/^([A-Z0-9]+)[-/_]/i)
    if (separatorMatch) {
      return separatorMatch[1].toUpperCase()
    }
    const usdtMatch = symbol.match(/^([A-Z]+)USDT?$/i)
    if (usdtMatch) {
      return usdtMatch[1].toUpperCase()
    }
    return symbol.replace(/USDT?$/i, '').toUpperCase()
  }

  private extractTriggerPricesFromOrders(
    orders: StandXOrder[]
  ): Map<string, { upPrice: number | null; downPrice: number | null }> {
    const triggerMap = new Map<string, { upPrice: number | null; downPrice: number | null }>()

    const tpSlOrders = orders.filter(
      (o) => o.reduce_only === true && o.condition?.group === 'position_tp_sl'
    )

    for (const order of tpSlOrders) {
      const key = order.position_id != null ? String(order.position_id) : order.symbol

      if (!triggerMap.has(key)) {
        triggerMap.set(key, { upPrice: null, downPrice: null })
      }

      const trigger = triggerMap.get(key)!
      const price = parseFloat(order.condition?.trigger_price ?? order.price)
      const safePrice = isNaN(price) ? null : price

      if (order.condition?.direction === 'up') {
        trigger.upPrice = safePrice
      } else if (order.condition?.direction === 'down') {
        trigger.downPrice = safePrice
      }
    }

    return triggerMap
  }

  private transformPositions(
    positions: StandXPosition[],
    triggerMap: Map<string, { upPrice: number | null; downPrice: number | null }>
  ): Position[] {
    return positions
      .filter((p) => {
        const qty = parseFloat(p.qty)
        return qty !== 0 && !isNaN(qty)
      })
      .map((p) => {
        const qty = parseFloat(p.qty)
        const size = Math.abs(qty)
        const side = qty > 0 ? 'long' : 'short'
        const entryPrice = parseFloat(p.entry_price)
        const markPrice = parseFloat(p.mark_price)
        const sizeUsd = Math.abs(parseFloat(p.position_value))
        const unrealizedPnl = parseFloat(p.upnl)
        const leverage = parseFloat(p.leverage)
        const margin = parseFloat(p.holding_margin) || parseFloat(p.initial_margin)
        const unrealizedPnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0
        const rawMmr = parseFloat(p.mmr)
        const marginRatio = isNaN(rawMmr) ? null : rawMmr
        const rawLiqPrice = parseFloat(p.liq_price)
        const liquidationPrice = isNaN(rawLiqPrice) ? null : rawLiqPrice
        const baseAsset = this.extractBaseAsset(p.symbol)
        const market = `${baseAsset}-PERP`

        const trigger = triggerMap.get(String(p.id)) ?? triggerMap.get(p.symbol)
        let stopLoss: number | null = null
        let takeProfit: number | null = null
        if (trigger) {
          if (side === 'long') {
            takeProfit = trigger.upPrice
            stopLoss = trigger.downPrice
          } else {
            stopLoss = trigger.upPrice
            takeProfit = trigger.downPrice
          }
        }

        return {
          id: generatePositionId(this.exchangeId, market, side),
          exchange: this.exchangeId,
          market,
          baseAsset,
          side,
          size,
          sizeUsd,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          leverage,
          liquidationPrice,
          stopLoss,
          takeProfit,
          margin,
          marginRatio,
          createdAt: p.created_at ? new Date(p.created_at) : null,
          updatedAt: p.updated_at ? new Date(p.updated_at) : new Date(),
        }
      })
  }

  async getPositions(_query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    try {
      const positionsResponse = await this.fetchWithAuth(
        `${this.baseUrl}/api/query_positions`
      )

      if (!positionsResponse.ok) {
        throw new Error(`StandX positions API error: ${positionsResponse.status}`)
      }

      const rawData = await positionsResponse.json()
      const rawPositions: StandXPosition[] = Array.isArray(rawData) ? rawData : []

      if (rawPositions.length === 0) {
        return this.createSuccessResponse([])
      }

      let triggerMap = new Map<string, { upPrice: number | null; downPrice: number | null }>()

      try {
        const ordersResponse = await this.fetchWithAuth(
          `${this.baseUrl}/api/query_open_orders`
        )

        if (ordersResponse.ok) {
          const ordersData: StandXOrdersResponse = await ordersResponse.json()
          if (ordersData.result) {
            triggerMap = this.extractTriggerPricesFromOrders(ordersData.result)
          }
        }
      } catch {
        // silently ignore order fetch failures
      }

      const positions = this.transformPositions(rawPositions, triggerMap)
      return this.createSuccessResponse(positions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getAccountBalance(_query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    try {
      const response = await this.fetchWithAuth(`${this.baseUrl}/api/query_balance`)

      if (!response.ok) {
        throw new Error(`StandX balance API error: ${response.status}`)
      }

      const balance: StandXBalance = await response.json()

      const totalEquity = parseFloat(balance.equity) || 0
      const availableBalance = parseFloat(balance.cross_available) || 0
      const crossMargin = parseFloat(balance.cross_margin) || 0
      const isolatedBalance = parseFloat(balance.isolated_balance) || 0
      const usedMargin = crossMargin + isolatedBalance
      const unrealizedPnl = parseFloat(balance.upnl) || 0

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
}
