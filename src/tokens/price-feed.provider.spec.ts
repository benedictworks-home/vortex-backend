import { CoinGeckoPriceFeedProvider } from "./price-feed.provider";
import { EgressPurpose, EgressResponse, HttpEgressService } from "../common/http-egress";

describe("CoinGeckoPriceFeedProvider", () => {
  const originalCoinIds = process.env.PRICE_FEED_COIN_IDS;
  const originalApiKey = process.env.PRICE_FEED_API_KEY;
  let egressFetch: jest.SpyInstance;

  afterEach(() => {
    if (originalCoinIds === undefined) delete process.env.PRICE_FEED_COIN_IDS;
    else process.env.PRICE_FEED_COIN_IDS = originalCoinIds;
    if (originalApiKey === undefined) delete process.env.PRICE_FEED_API_KEY;
    else process.env.PRICE_FEED_API_KEY = originalApiKey;
    jest.restoreAllMocks();
  });

  it("resolves a symbol to a CoinGecko ID and returns its USD price", async () => {
    process.env.PRICE_FEED_COIN_IDS = JSON.stringify({ TEST: "test-coin" });
    egressFetch = jest.spyOn(HttpEgressService.prototype, "fetch").mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ "test-coin": { usd: 12.5 } }),
    } as EgressResponse);

    await expect(new CoinGeckoPriceFeedProvider().getUsdPrice("test")).resolves.toBe(12.5);
    const [request, options] = egressFetch.mock.calls[0];
    expect(request).toContain("ids=test-coin");
    expect(options.purpose).toBe(EgressPurpose.ORACLE);
  });

  it("rejects aliases that do not resolve to a USD price", async () => {
    process.env.PRICE_FEED_COIN_IDS = JSON.stringify({ TEST: "test-coin" });
    jest.spyOn(HttpEgressService.prototype, "fetch").mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ "test-coin": { usd: "12.5" } }),
    } as EgressResponse);

    await expect(new CoinGeckoPriceFeedProvider().getUsdPrice("TEST")).rejects.toThrow(
      "invalid USD price",
    );
  });

  it("rejects malformed symbol mappings during construction", () => {
    process.env.PRICE_FEED_COIN_IDS = "[]";
    expect(() => new CoinGeckoPriceFeedProvider()).toThrow("must be a JSON object");
  });
});