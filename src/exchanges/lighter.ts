import type { ExchangeId, Position, AccountBalance, ExchangeResponse, AddressQuery, LighterConfig } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId, isValidEvmAddress } from '../utils'

const LIGHTER_API_BASE = 'https://mainnet.zklighter.elliot.ai'

interface LighterAccountResponse {
  code: number
  total: number
  accounts: LighterAccount[]
}

interface LighterAccount {
  code: number
  account_type: number
  index: number
  account_index: number
  l1_address: string
  available_balance: string
  collateral: string
  total_asset_value: string
  positions: LighterPosition[]
}

interface LighterPosition {
  market_id: number
  symbol: string
  initial_margin_fraction: string
  open_order_count: number
  position_tied_order_count: number
  sign: number
  position: string
  avg_entry_price: string
  position_value: string
  unrealized_pnl: string
  realized_pnl: string
  liquidation_price: string
  margin_mode: number
  allocated_margin: string
}

interface LighterActiveOrder {
  order_index: number
  order_id: string
  market_index: number
  type: string
  is_ask: boolean
  price: string
  trigger_price: string
  status: string
}

interface LighterActiveOrdersResponse {
  code: number
  orders: LighterActiveOrder[]
}

export class LighterClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'lighter'
  private baseUrl: string
  private apiKey: string
  private accountIndex: number | null
  private apiKeyIndex: number
  private hasPrivateKey: boolean = false
  private tokenExpiresAt: number = 0
  private static readonly TOKEN_LIFETIME = 3600
  private static readonly TOKEN_REFRESH_MARGIN = 300 // refresh 5 min before expiry

  constructor(config?: LighterConfig, baseUrl = LIGHTER_API_BASE) {
    super()
    this.baseUrl = baseUrl
    this.accountIndex = config?.accountIndex ?? null
    this.apiKeyIndex = config?.apiKeyIndex ?? 0

    if (config?.apiKey) {
      this.apiKey = config.apiKey
    } else if (config?.privateKey) {
      const { createLighterAuthToken } = require('../signers/lighter-signer')
      this.apiKey = createLighterAuthToken(
        config.privateKey,
        this.accountIndex ?? 0,
        this.apiKeyIndex
      )
      this.hasPrivateKey = true
      this.tokenExpiresAt = Date.now() + LighterClient.TOKEN_LIFETIME * 1000
    } else {
      this.apiKey = ''
    }
  }

  private refreshTokenIfNeeded(): void {
    if (!this.hasPrivateKey) return
    if (Date.now() < this.tokenExpiresAt - LighterClient.TOKEN_REFRESH_MARGIN * 1000) return

    const { refreshLighterAuthToken } = require('../signers/lighter-signer')
    this.apiKey = refreshLighterAuthToken(
      this.apiKeyIndex,
      this.accountIndex ?? 0
    )
    this.tokenExpiresAt = Date.now() + LighterClient.TOKEN_LIFETIME * 1000
  }

  private async fetchPublic(url: string): Promise<Response> {
    return fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    })
  }

  private async fetchWithAuth(url: string): Promise<Response> {
    this.refreshTokenIfNeeded()

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }

    if (this.apiKey) {
      headers['Authorization'] = this.apiKey
    }

    return fetch(url, { method: 'GET', headers })
  }

  private buildAccountUrl(query?: AddressQuery): string {
    const address = query?.address
    if (address && isValidEvmAddress(address)) {
      return `${this.baseUrl}/api/v1/account?by=l1_address&value=${address}`
    }
    if (this.accountIndex != null) {
      return `${this.baseUrl}/api/v1/account?by=index&value=${this.accountIndex}`
    }
    return ''
  }

  private async fetchAccount(query?: AddressQuery): Promise<LighterAccountResponse> {
    const url = this.buildAccountUrl(query)
    if (!url) {
      throw new Error('Either an EVM address (via query) or accountIndex (via config) is required')
    }

    const isAddressMode = !!query?.address && isValidEvmAddress(query.address)
    const response = isAddressMode
      ? await this.fetchPublic(url)
      : await this.fetchWithAuth(url)

    if (!response.ok) {
      throw new Error(`Lighter API error: ${response.status}`)
    }

    return response.json()
  }

  private async getActiveOrders(
    accountIndex: number,
    marketId: number
  ): Promise<LighterActiveOrder[]> {
    try {
      const url = `${this.baseUrl}/api/v1/accountActiveOrders?account_index=${accountIndex}&market_id=${marketId}`
      const response = await this.fetchWithAuth(url)

      if (!response.ok) return []

      const data: LighterActiveOrdersResponse = await response.json()
      if (data.code !== 200) return []

      return data.orders || []
    } catch {
      return []
    }
  }

  private async getActiveOrdersForMarkets(
    accountIndex: number,
    marketIds: number[]
  ): Promise<Map<number, LighterActiveOrder[]>> {
    const ordersMap = new Map<number, LighterActiveOrder[]>()
    const results = await Promise.all(
      marketIds.map(async (marketId) => {
        const orders = await this.getActiveOrders(accountIndex, marketId)
        return { marketId, orders }
      })
    )
    for (const { marketId, orders } of results) {
      ordersMap.set(marketId, orders)
    }
    return ordersMap
  }

  async getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    try {
      const data = await this.fetchAccount(query)

      if (data.code !== 200 || !data.accounts || data.accounts.length === 0) {
        return this.createSuccessResponse([])
      }

      const account = data.accounts[0]
      const accountIdx = account.account_index || account.index

      const openPositions = (account.positions || []).filter(
        (p) => parseFloat(p.position) !== 0
      )
      const marketIds = [...new Set(openPositions.map((p) => p.market_id))]

      let slTpMap = new Map<number, { stopLoss: number | null; takeProfit: number | null }>()

      if (this.apiKey && accountIdx && marketIds.length > 0) {
        const ordersMap = await this.getActiveOrdersForMarkets(accountIdx, marketIds)
        slTpMap = this.extractSlTpFromActiveOrders(ordersMap)
      }

      const positions = this.transformPositions(account.positions || [], slTpMap)
      return this.createSuccessResponse(positions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  private extractSlTpFromActiveOrders(
    ordersMap: Map<number, LighterActiveOrder[]>
  ): Map<number, { stopLoss: number | null; takeProfit: number | null }> {
    const slTpMap = new Map<number, { stopLoss: number | null; takeProfit: number | null }>()

    for (const [marketId, orders] of ordersMap) {
      if (!slTpMap.has(marketId)) {
        slTpMap.set(marketId, { stopLoss: null, takeProfit: null })
      }

      const slTp = slTpMap.get(marketId)!

      for (const order of orders) {
        const triggerPrice = parseFloat(order.trigger_price)

        if (order.type === 'stop-loss') {
          slTp.stopLoss = triggerPrice || null
        } else if (order.type === 'take-profit') {
          slTp.takeProfit = triggerPrice || null
        }
      }
    }

    return slTpMap
  }

  async getAccountBalance(query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    try {
      const data = await this.fetchAccount(query)

      if (data.code !== 200 || !data.accounts || data.accounts.length === 0) {
        return this.createSuccessResponse({
          exchange: this.exchangeId,
          totalEquity: 0,
          availableBalance: 0,
          usedMargin: 0,
          unrealizedPnl: 0,
        })
      }

      const account = data.accounts[0]
      const totalEquity = parseFloat(account.total_asset_value) || 0
      const availableBalance = parseFloat(account.available_balance) || 0
      const collateral = parseFloat(account.collateral) || 0
      const unrealizedPnl = (account.positions || []).reduce(
        (sum, p) => sum + (parseFloat(p.unrealized_pnl) || 0),
        0
      )

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity,
        availableBalance,
        usedMargin: collateral - availableBalance,
        unrealizedPnl,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private transformPositions(
    positions: LighterPosition[],
    slTpMap: Map<number, { stopLoss: number | null; takeProfit: number | null }>
  ): Position[] {
    return positions
      .filter((p) => {
        const positionSize = parseFloat(p.position)
        return positionSize !== 0 && !isNaN(positionSize)
      })
      .map((p) => {
        const size = Math.abs(parseFloat(p.position))
        const entryPrice = parseFloat(p.avg_entry_price)
        const positionValue = Math.abs(parseFloat(p.position_value))
        const unrealizedPnl = parseFloat(p.unrealized_pnl)
        const side = p.sign === 1 ? 'long' : 'short'
        const initialMarginFraction = parseFloat(p.initial_margin_fraction)
        const leverage = initialMarginFraction > 0 ? Math.round(100 / initialMarginFraction) : 1
        const margin = positionValue / leverage
        const unrealizedPnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0
        const markPrice = size > 0 ? positionValue / size : entryPrice
        const market = `${p.symbol}-PERP`
        const slTp = slTpMap.get(p.market_id)

        return {
          id: generatePositionId(this.exchangeId, market, side),
          exchange: this.exchangeId,
          market,
          baseAsset: p.symbol,
          side,
          size,
          sizeUsd: positionValue,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          leverage,
          liquidationPrice: parseFloat(p.liquidation_price) || null,
          stopLoss: slTp?.stopLoss || null,
          takeProfit: slTp?.takeProfit || null,
          margin,
          marginRatio: initialMarginFraction,
          createdAt: null,
          updatedAt: new Date(),
        }
      })
  }
}
