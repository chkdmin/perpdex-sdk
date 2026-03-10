import type { ExchangeId, Position, AccountBalance, ExchangeResponse, AddressQuery } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId, isValidSolanaAddress } from '../utils'

const PACIFICA_API_BASE = 'https://api.pacifica.fi'

interface PacificaAccountResponse {
  success: boolean
  data: {
    balance: string
    fee_level: number
    account_equity: string
    available_to_spend: string
    available_to_withdraw: string
    pending_balance: string
    total_margin_used: string
    cross_mmr: string
    positions_count: number
    orders_count: number
    stop_orders_count: number
    updated_at: number
    use_ltp_for_stop_orders: boolean
  }
  error: string | null
  code: string | null
}

interface PacificaPosition {
  symbol: string
  side: 'bid' | 'ask'
  amount: string
  entry_price: string
  margin: string
  funding: string
  isolated: boolean
  liquidation_price: string
  created_at: number
  updated_at: number
}

interface PacificaPositionsResponse {
  success: boolean
  data: PacificaPosition[]
  error: string | null
  code: string | null
}

interface PacificaOrder {
  order_id: number
  client_order_id: string | null
  symbol: string
  side: 'bid' | 'ask'
  price: string
  initial_amount: string
  filled_amount: string
  cancelled_amount: string
  stop_price: string
  order_type: string
  stop_parent_order_id: number | null
  reduce_only: boolean
  created_at: number
  updated_at: number
}

interface PacificaOrdersResponse {
  success: boolean
  data: PacificaOrder[]
  error: string | null
  code: string | null
}

interface SymbolSlTp {
  stopLoss: number | null
  takeProfit: number | null
}

export class PacificaClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'pacifica'
  private baseUrl: string

  constructor(baseUrl = PACIFICA_API_BASE) {
    super()
    this.baseUrl = baseUrl
  }

  async getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    const address = query?.address
    if (!address || !isValidSolanaAddress(address)) {
      return this.createErrorResponse('Invalid or missing Solana address')
    }

    try {
      const [positionsResponse, accountResponse, ordersResponse] = await Promise.all([
        fetch(`${this.baseUrl}/api/v1/positions?account=${address}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
        fetch(`${this.baseUrl}/api/v1/account?account=${address}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
        fetch(`${this.baseUrl}/api/v1/orders?account=${address}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
      ])

      if (!positionsResponse.ok) {
        throw new Error(`Pacifica API error: ${positionsResponse.status}`)
      }

      const positionsData: PacificaPositionsResponse = await positionsResponse.json()

      if (!positionsData.success) {
        throw new Error(positionsData.error || 'Pacifica API error')
      }

      let totalUnrealizedPnl = 0
      let totalMarginUsed = 0
      if (accountResponse.ok) {
        const accountData: PacificaAccountResponse = await accountResponse.json()
        if (accountData.success) {
          const balance = parseFloat(accountData.data.balance) || 0
          const equity = parseFloat(accountData.data.account_equity) || 0
          totalUnrealizedPnl = equity - balance
          totalMarginUsed = parseFloat(accountData.data.total_margin_used) || 0
        }
      }

      const slTpMap = new Map<string, SymbolSlTp>()
      if (ordersResponse.ok) {
        const ordersData: PacificaOrdersResponse = await ordersResponse.json()
        if (ordersData.success && ordersData.data) {
          for (const order of ordersData.data) {
            if (!slTpMap.has(order.symbol)) {
              slTpMap.set(order.symbol, { stopLoss: null, takeProfit: null })
            }
            const slTp = slTpMap.get(order.symbol)!
            if (order.order_type.includes('stop_loss')) {
              slTp.stopLoss = parseFloat(order.stop_price) || null
            } else if (order.order_type.includes('take_profit')) {
              slTp.takeProfit = parseFloat(order.stop_price) || null
            }
          }
        }
      }

      const positions = this.transformPositions(
        positionsData.data || [],
        totalUnrealizedPnl,
        totalMarginUsed,
        slTpMap
      )

      return this.createSuccessResponse(positions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getAccountBalance(query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    const address = query?.address
    if (!address || !isValidSolanaAddress(address)) {
      return this.createErrorResponse('Invalid or missing Solana address')
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/account?account=${address}`,
        { method: 'GET', headers: { Accept: 'application/json' } }
      )

      if (!response.ok) {
        throw new Error(`Pacifica API error: ${response.status}`)
      }

      const data: PacificaAccountResponse = await response.json()

      if (!data.success) {
        throw new Error(data.error || 'Pacifica API error')
      }

      const accountData = data.data
      const balance = parseFloat(accountData.balance) || 0
      const equity = parseFloat(accountData.account_equity) || 0

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity: equity,
        availableBalance: parseFloat(accountData.available_to_spend) || 0,
        usedMargin: parseFloat(accountData.total_margin_used) || 0,
        unrealizedPnl: equity - balance,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private transformPositions(
    positions: PacificaPosition[],
    totalUnrealizedPnl: number,
    totalMarginUsed: number,
    slTpMap: Map<string, SymbolSlTp>
  ): Position[] {
    if (positions.length === 0) return []

    const positionsWithValue = positions.map((p) => {
      const size = parseFloat(p.amount)
      const entryPrice = parseFloat(p.entry_price)
      const notionalValue = size * entryPrice
      return { position: p, notionalValue }
    })

    const totalNotional = positionsWithValue.reduce(
      (sum, p) => sum + p.notionalValue,
      0
    )

    return positionsWithValue.map(({ position: p, notionalValue }) => {
      const size = parseFloat(p.amount)
      const entryPrice = parseFloat(p.entry_price)
      const side = p.side === 'bid' ? 'long' : 'short'
      const market = `${p.symbol}-PERP`

      const pnlRatio = totalNotional > 0 ? notionalValue / totalNotional : 1
      const unrealizedPnl = totalUnrealizedPnl * pnlRatio

      let markPrice = entryPrice
      if (size > 0) {
        if (side === 'long') {
          markPrice = entryPrice + unrealizedPnl / size
        } else {
          markPrice = entryPrice - unrealizedPnl / size
        }
      }

      const sizeUsd = size * markPrice

      let margin: number
      if (p.isolated) {
        margin = parseFloat(p.margin) || 0
      } else {
        margin = totalMarginUsed * pnlRatio
      }

      const leverage = margin > 0 ? Math.round(notionalValue / margin) : 1
      const unrealizedPnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0

      const slTp = slTpMap.get(p.symbol)

      return {
        id: generatePositionId(this.exchangeId, market, side),
        exchange: this.exchangeId,
        market,
        baseAsset: p.symbol,
        side,
        size,
        sizeUsd,
        entryPrice,
        markPrice,
        unrealizedPnl,
        unrealizedPnlPercent,
        leverage,
        liquidationPrice: parseFloat(p.liquidation_price) || null,
        stopLoss: slTp?.stopLoss || null,
        takeProfit: slTp?.takeProfit || null,
        margin,
        marginRatio: null,
        createdAt: p.created_at ? new Date(p.created_at) : null,
        updatedAt: p.updated_at ? new Date(p.updated_at) : new Date(),
      }
    })
  }
}
