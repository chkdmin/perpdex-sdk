import type { ExchangeId, Position, AccountBalance, SpotBalance, ExchangeResponse, AddressQuery, GrvtConfig } from '../types'
import { BaseClient } from '../base/base-client'
import { generatePositionId } from '../utils'

const GRVT_AUTH_ENDPOINT = 'https://edge.grvt.io/auth/api_key/login'
const GRVT_API_BASE = 'https://trades.grvt.io'
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

interface GrvtPosition {
  instrument: string
  size: string
  notional: string
  entry_price: string
  mark_price: string
  est_liquidation_price: string
  unrealized_pnl: string
  realized_pnl: string
  total_pnl: string
  roi: string
  quote_index_price: string
  leverage: string
  event_time?: string
  update_time?: string
}

interface GrvtPositionsResponse {
  result: GrvtPosition[]
}

interface GrvtSubAccountSummary {
  sub_account_id: string
  total_equity: string
  available_balance: string
  initial_margin: string
  maintenance_margin: string
  unrealized_pnl: string
}

interface GrvtAccountSummaryResponse {
  result: GrvtSubAccountSummary
}

interface GrvtFundingBalance {
  currency: string
  balance: string
  locked_balance: string
}

interface GrvtFundingAccountSummary {
  result: {
    balances: GrvtFundingBalance[]
  }
}

interface GrvtOpenOrder {
  order_id: string
  sub_account_id: string
  is_market: boolean
  time_in_force: string
  reduce_only: boolean
  legs: Array<{
    instrument: string
    size: string
    limit_price: string
    is_buying_asset: boolean
  }>
  metadata?: {
    client_order_id?: string
    trigger?: {
      trigger_type: string
      tpsl?: {
        trigger_by: string
        trigger_price: string
        close_position: boolean
      }
    }
  }
  state?: {
    status: string
  }
}

interface GrvtOpenOrdersResponse {
  result: GrvtOpenOrder[]
}

export class GrvtClient extends BaseClient {
  readonly exchangeId: ExchangeId = 'grvt'
  private apiKey: string
  private tradingAccountId: string
  private sessionCookie: string | null = null
  private accountId: string | null = null
  private sessionExpiry: number = 0

  constructor(config: GrvtConfig) {
    super()
    this.apiKey = config.apiKey
    this.tradingAccountId = config.tradingAccountId
  }

  private async authenticate(): Promise<void> {
    const response = await fetch(GRVT_AUTH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Cookie: 'rm=true;',
      },
      body: JSON.stringify({ api_key: this.apiKey }),
    })

    const responseBody = await response.text()

    if (!response.ok) {
      throw new Error(`GRVT auth failed: ${response.status} - ${responseBody}`)
    }

    try {
      const authData = JSON.parse(responseBody)
      if (authData.error && authData.status !== 'success') {
        throw new Error(`GRVT auth error: ${JSON.stringify(authData)}`)
      }
    } catch (parseError) {
      if (!(parseError instanceof SyntaxError)) {
        throw parseError
      }
    }

    // Extract session cookie
    let cookies: string[] = []
    if (typeof response.headers.getSetCookie === 'function') {
      cookies = response.headers.getSetCookie()
    } else {
      const setCookieHeader = response.headers.get('set-cookie')
      if (setCookieHeader) {
        cookies = [setCookieHeader]
      }
    }

    for (const cookie of cookies) {
      const gravityMatch = cookie.match(/gravity=([^;]*)/)
      if (gravityMatch) {
        this.sessionCookie = `gravity=${gravityMatch[1]}`
        break
      }
    }

    this.accountId = response.headers.get('x-grvt-account-id')
    this.sessionExpiry = Date.now() + 60 * 60 * 1000
  }

  private async ensureSession(): Promise<void> {
    const now = Date.now()
    if (
      !this.sessionCookie ||
      !this.accountId ||
      this.sessionExpiry - now < 5 * 60 * 1000
    ) {
      await this.authenticate()
    }
  }

  private async authenticatedPost<T>(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<T> {
    await this.ensureSession()

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    }

    if (this.sessionCookie) {
      headers['Cookie'] = this.sessionCookie
    }
    if (this.accountId) {
      headers['X-Grvt-Account-Id'] = this.accountId
    }

    const response = await fetch(`${GRVT_API_BASE}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`GRVT API error: ${response.status} - ${errorText}`)
    }

    return response.json()
  }

  async getSpotBalances(_query?: AddressQuery): Promise<ExchangeResponse<SpotBalance[]>> {
    try {
      await this.ensureSession()

      const response = await this.authenticatedPost<GrvtFundingAccountSummary>(
        '/full/v1/get_funding_account_summary',
        { sub_account_id: this.tradingAccountId }
      )

      const balances = response.result?.balances || []

      const spotBalances: SpotBalance[] = balances
        .filter((b) => parseFloat(b.balance) !== 0)
        .map((b) => ({
          symbol: b.currency,
          balance: b.balance,
          lockedBalance: b.locked_balance || '0',
        }))

      return this.createSuccessResponse(spotBalances)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch spot balances'
      )
    }
  }

  async getPositions(_query?: AddressQuery): Promise<ExchangeResponse<Position[]>> {
    try {
      await this.ensureSession()

      const positionsResponse = await this.authenticatedPost<GrvtPositionsResponse>(
        '/full/v1/positions',
        {
          sub_account_id: this.tradingAccountId,
          kind: ['PERPETUAL'],
        }
      )

      let openOrders: GrvtOpenOrder[] = []
      try {
        const ordersResponse = await this.authenticatedPost<GrvtOpenOrdersResponse>(
          '/full/v1/open_orders',
          {
            sub_account_id: this.tradingAccountId,
            kind: ['PERPETUAL'],
          }
        )
        openOrders = ordersResponse.result || []
      } catch {
        // silently ignore order fetch failures
      }

      const slTpMap = this.extractSlTpFromOrders(openOrders)
      const positions = this.transformPositions(positionsResponse.result || [], slTpMap)

      return this.createSuccessResponse(positions)
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch positions'
      )
    }
  }

  async getAccountBalance(_query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>> {
    try {
      await this.ensureSession()

      const response = await this.authenticatedPost<GrvtAccountSummaryResponse>(
        '/full/v1/account_summary',
        { sub_account_id: this.tradingAccountId }
      )

      const summary = response.result

      return this.createSuccessResponse({
        exchange: this.exchangeId,
        totalEquity: parseFloat(summary.total_equity) || 0,
        availableBalance: parseFloat(summary.available_balance) || 0,
        usedMargin: parseFloat(summary.initial_margin) || 0,
        unrealizedPnl: parseFloat(summary.unrealized_pnl) || 0,
      })
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch account balance'
      )
    }
  }

  private extractSlTpFromOrders(
    orders: GrvtOpenOrder[]
  ): Map<string, { stopLoss: number | null; takeProfit: number | null }> {
    const slTpMap = new Map<string, { stopLoss: number | null; takeProfit: number | null }>()

    for (const order of orders) {
      const instrument = order.legs?.[0]?.instrument
      if (!instrument) continue

      if (!slTpMap.has(instrument)) {
        slTpMap.set(instrument, { stopLoss: null, takeProfit: null })
      }

      const slTp = slTpMap.get(instrument)!
      const triggerType = order.metadata?.trigger?.trigger_type
      const triggerPrice = order.metadata?.trigger?.tpsl?.trigger_price

      if (triggerPrice) {
        const price = parseFloat(triggerPrice)
        if (triggerType === 'STOP_LOSS') {
          slTp.stopLoss = price || null
        } else if (triggerType === 'TAKE_PROFIT') {
          slTp.takeProfit = price || null
        }
      }
    }

    return slTpMap
  }

  private transformPositions(
    positions: GrvtPosition[],
    slTpMap: Map<string, { stopLoss: number | null; takeProfit: number | null }>
  ): Position[] {
    return positions
      .filter((p) => {
        const size = parseFloat(p.size)
        return size !== 0 && !isNaN(size)
      })
      .map((p) => {
        const sizeNum = parseFloat(p.size)
        const size = Math.abs(sizeNum)
        const entryPrice = parseFloat(p.entry_price)
        const markPrice = parseFloat(p.mark_price)
        const notional = Math.abs(parseFloat(p.notional))
        const unrealizedPnl = parseFloat(p.unrealized_pnl)
        const side = sizeNum > 0 ? 'long' : 'short'
        const leverage = parseFloat(p.leverage) || 10
        const margin = notional / leverage
        const unrealizedPnlPercent = margin > 0 ? (unrealizedPnl / margin) * 100 : 0
        const parts = p.instrument.split('_')
        const baseAsset = parts[0] || p.instrument
        const market = `${baseAsset}-PERP`
        const slTp = slTpMap.get(p.instrument)

        return {
          id: generatePositionId(this.exchangeId, market, side),
          exchange: this.exchangeId,
          market,
          baseAsset,
          side,
          size,
          sizeUsd: notional,
          entryPrice,
          markPrice,
          unrealizedPnl,
          unrealizedPnlPercent,
          leverage,
          liquidationPrice: parseFloat(p.est_liquidation_price) || null,
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
