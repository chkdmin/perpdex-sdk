export type ExchangeId =
  | 'hyperliquid'
  | 'lighter'
  | 'pacifica'
  | 'aster'
  | 'grvt'
  | 'backpack'
  | 'extended'
  | 'standx'

export type PositionSide = 'long' | 'short'

export interface Position {
  id: string
  exchange: ExchangeId
  market: string
  baseAsset: string
  side: PositionSide
  size: number
  sizeUsd: number
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  leverage: number
  liquidationPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  margin: number
  marginRatio: number | null
  createdAt: Date | null
  updatedAt: Date
}

export interface AccountBalance {
  exchange: ExchangeId
  totalEquity: number
  availableBalance: number
  usedMargin: number
  unrealizedPnl: number
}

export interface ExchangeResponse<T> {
  success: boolean
  data: T | null
  error: string | null
  exchange: ExchangeId
}

export interface AddressQuery {
  address: string
}

export interface LighterConfig {
  apiKey?: string
  privateKey?: string
  apiKeyIndex?: number
  accountIndex?: number
  apiSecret?: string
}

export interface AsterConfig {
  apiKey: string
  apiSecret: string
}

export interface GrvtConfig {
  apiKey: string
  apiSecret: string
  tradingAccountId: string
}

export interface BackpackConfig {
  apiKey: string
  apiSecret: string
}

export interface ExtendedConfig {
  apiKey: string
  apiSecret: string
}

export interface StandXConfig {
  jwtToken: string
}

export interface ExchangeConfigMap {
  hyperliquid: undefined
  pacifica: undefined
  lighter: LighterConfig | undefined
  aster: AsterConfig
  grvt: GrvtConfig
  backpack: BackpackConfig
  extended: ExtendedConfig
  standx: StandXConfig
}

export interface SpotBalance {
  symbol: string
  balance: string
  lockedBalance: string
}

export interface ExchangeClient {
  readonly exchangeId: ExchangeId
  getPositions(query?: AddressQuery): Promise<ExchangeResponse<Position[]>>
  getAccountBalance(query?: AddressQuery): Promise<ExchangeResponse<AccountBalance>>
  getSpotBalances?(query?: AddressQuery): Promise<ExchangeResponse<SpotBalance[]>>
}
