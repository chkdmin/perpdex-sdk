# @chkdmin/perpdex-sdk

Perpetual DEX 거래소들의 포지션과 잔고를 통합 인터페이스로 조회하는 TypeScript SDK.

## Supported Exchanges

| Exchange | Auth Type | Required Config |
|----------|-----------|-----------------|
| Hyperliquid | Wallet Address | - |
| Pacifica | Wallet Address (Solana) | - |
| Lighter | API Key | `apiKey`, `apiSecret`, `accountIndex?` |
| Aster | API Key (HMAC) | `apiKey`, `apiSecret` |
| Backpack | API Key (ED25519) | `apiKey`, `apiSecret` |
| GRVT | API Key (Session) | `apiKey`, `apiSecret`, `tradingAccountId` |
| Extended | API Key | `apiKey`, `apiSecret` |
| StandX | JWT Token | `jwtToken` |

## Installation

```bash
npm install @chkdmin/perpdex-sdk
```

## Quick Start

```typescript
import { createClient } from '@chkdmin/perpdex-sdk'

// Hyperliquid - 지갑 주소로 조회
const hl = createClient('hyperliquid')
const positions = await hl.getPositions({ address: '0x...' })
const balance = await hl.getAccountBalance({ address: '0x...' })

if (positions.success) {
  console.log(positions.data) // Position[]
}
```

## Usage

### Address-based Exchanges

Hyperliquid과 Pacifica는 지갑 주소만으로 조회 가능합니다. 별도의 인증 설정이 필요 없습니다.

```typescript
import { createClient } from '@chkdmin/perpdex-sdk'

// Hyperliquid (EVM address)
const hl = createClient('hyperliquid')
const result = await hl.getPositions({ address: '0xYourEvmAddress' })

// Pacifica (Solana address)
const pacifica = createClient('pacifica')
const result = await pacifica.getPositions({ address: 'YourSolanaAddress' })
```

### API Key-based Exchanges

API Key가 필요한 거래소는 `createClient` 두 번째 인자에 config를 전달합니다.

```typescript
import { createClient } from '@chkdmin/perpdex-sdk'

// Lighter
const lighter = createClient('lighter', {
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
  accountIndex: 0, // optional
})

// Aster (Binance-compatible)
const aster = createClient('aster', {
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
})

// Backpack (ED25519 signing)
const backpack = createClient('backpack', {
  apiKey: 'your-api-key',
  apiSecret: 'base64-encoded-private-key',
})

// GRVT (Session-based)
const grvt = createClient('grvt', {
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
  tradingAccountId: 'your-sub-account-id',
})

// Extended
const extended = createClient('extended', {
  apiKey: 'your-api-key',
  apiSecret: 'your-api-secret',
})

// StandX (JWT)
const standx = createClient('standx', {
  jwtToken: 'your-jwt-token',
})
```

### Fetching Positions

```typescript
const result = await client.getPositions()

if (result.success) {
  for (const position of result.data!) {
    console.log(`${position.market} ${position.side}`)
    console.log(`  Size: ${position.size} (${position.sizeUsd} USD)`)
    console.log(`  Entry: ${position.entryPrice} → Mark: ${position.markPrice}`)
    console.log(`  PnL: ${position.unrealizedPnl} (${position.unrealizedPnlPercent.toFixed(2)}%)`)
    console.log(`  Leverage: ${position.leverage}x`)
    console.log(`  Liquidation: ${position.liquidationPrice}`)
    console.log(`  SL: ${position.stopLoss} / TP: ${position.takeProfit}`)
  }
} else {
  console.error(`Error: ${result.error}`)
}
```

### Fetching Account Balance

```typescript
const result = await client.getAccountBalance()

if (result.success) {
  const balance = result.data!
  console.log(`Equity: ${balance.totalEquity}`)
  console.log(`Available: ${balance.availableBalance}`)
  console.log(`Used Margin: ${balance.usedMargin}`)
  console.log(`Unrealized PnL: ${balance.unrealizedPnl}`)
}
```

### Direct Class Import

팩토리 함수 대신 클라이언트 클래스를 직접 import할 수도 있습니다.

```typescript
import { HyperliquidClient, LighterClient } from '@chkdmin/perpdex-sdk'

const hl = new HyperliquidClient()
const lighter = new LighterClient({
  apiKey: 'key',
  apiSecret: 'secret',
})
```

## Type Definitions

### Position

```typescript
interface Position {
  id: string                        // "exchange_market_side"
  exchange: ExchangeId
  market: string                    // e.g. "BTC-PERP"
  baseAsset: string                 // e.g. "BTC"
  side: 'long' | 'short'
  size: number                      // Base asset quantity
  sizeUsd: number                   // Notional value in USD
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  unrealizedPnlPercent: number      // ROE %
  leverage: number
  liquidationPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  margin: number
  marginRatio: number | null
  createdAt: Date | null
  updatedAt: Date
}
```

### AccountBalance

```typescript
interface AccountBalance {
  exchange: ExchangeId
  totalEquity: number
  availableBalance: number
  usedMargin: number
  unrealizedPnl: number
}
```

### ExchangeResponse

모든 API 호출은 `ExchangeResponse<T>`를 반환합니다.

```typescript
interface ExchangeResponse<T> {
  success: boolean
  data: T | null
  error: string | null
  exchange: ExchangeId
}
```

## Error Handling

SDK는 예외를 throw하지 않습니다. 모든 에러는 `ExchangeResponse`를 통해 반환됩니다.

```typescript
const result = await client.getPositions()

if (!result.success) {
  console.error(`[${result.exchange}] ${result.error}`)
  // 에러 처리
}
```

## License

MIT
