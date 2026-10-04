import { Injectable } from "@nestjs/common";
import { EgressPurpose, HttpEgressService } from "../common/http-egress";

export interface PriceFeedProvider {
  getUsdPrice(symbol: string): Promise<number>;
}

export const PRICE_FEED_PROVIDER = Symbol("PRICE_FEED_PROVIDER");

const DEFAULT_COIN_IDS: Record<string, string> = {
  USDC: "usd-coin",
  USDT: "tether",
  WETH: "ethereum",
  "WETH.E": "ethereum",
  WBTC: "wrapped-bitcoin",
  MATIC: "matic-network",
  XLM: "stellar",
};

@Injectable()
export class CoinGeckoPriceFeedProvider implements PriceFeedProvider {
  private readonly coinIds: Record<string, string>;
  private readonly egress = new HttpEgressService({
    timeoutMs: 10_000,
    maxRedirects: 0,
    maxBodySizeBytes: 16_384,
    allowlist: ["api.coingecko.com"],
    blockPrivateRanges: true,
  });

  constructor() {
    let configured: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(process.env.PRICE_FEED_COIN_IDS ?? "{}");
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((id) => typeof id !== "string" || id.trim() === "")
      ) {
        throw new Error("invalid mapping");
      }
      configured = parsed as Record<string, string>;
    } catch {
      throw new Error("PRICE_FEED_COIN_IDS must be a JSON object of token symbols to CoinGecko IDs");
    }
    this.coinIds = {
      ...DEFAULT_COIN_IDS,
      ...Object.fromEntries(
        Object.entries(configured).map(([symbol, id]) => [symbol.toUpperCase(), id]),
      ),
    };
  }

  async getUsdPrice(symbol: string): Promise<number> {
    const coinId = this.coinIds[symbol.toUpperCase()];
    if (!coinId) throw new Error(`No CoinGecko ID configured for token symbol ${symbol}`);

    const url = new URL("https://api.coingecko.com/api/v3/simple/price");
    url.searchParams.set("ids", coinId);
    url.searchParams.set("vs_currencies", "usd");
    const apiKey = process.env.PRICE_FEED_API_KEY;
    const response = await this.egress.fetch(url.toString(), {
      purpose: EgressPurpose.ORACLE,
      ...(apiKey ? { headers: { "x-cg-demo-api-key": apiKey } } : {}),
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`CoinGecko returned HTTP ${response.statusCode}`);
    }

    const data = JSON.parse(response.body) as Record<string, { usd?: unknown }>;
    const price = data[coinId]?.usd;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new Error(`CoinGecko returned an invalid USD price for ${symbol}`);
    }
    return price;
  }
}
