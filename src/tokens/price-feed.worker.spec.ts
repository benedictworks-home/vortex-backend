import { ConfigService } from "@nestjs/config";
import { LeaderElectionService } from "../common/leader-election";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { PrismaService } from "../prisma/prisma.service";
import { PriceFeedProvider } from "./price-feed.provider";
import { PriceFeedWorker } from "./price-feed.worker";

describe("PriceFeedWorker", () => {
  const tokenFindMany = jest.fn();
  const tokenUpdate = jest.fn();
  const historyCreate = jest.fn();
  const transaction = jest.fn();
  const getUsdPrice = jest.fn();
  const pause = jest.fn();
  const registerWorker = jest.fn();
  const configGet = jest.fn();
  let worker: PriceFeedWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    tokenFindMany.mockResolvedValue([]);
    transaction.mockResolvedValue([]);
    configGet.mockImplementation((_key: string, fallback: number) => fallback);
    worker = new PriceFeedWorker(
      {
        token: { findMany: tokenFindMany, update: tokenUpdate },
        priceHistory: { create: historyCreate },
        $transaction: transaction,
      } as unknown as PrismaService,
      { getUsdPrice } as PriceFeedProvider,
      { pause } as unknown as KillSwitchService,
      { registerWorker } as unknown as LeaderElectionService,
      { get: configGet } as unknown as ConfigService,
    );
  });

  it("persists each valid price and a matching historical sample", async () => {
    tokenFindMany.mockResolvedValue([
      { id: "token-1", symbol: "XLM", priceUsd: 0.1 },
      { id: "token-2", symbol: "XLM", priceUsd: 0.1 },
    ]);
    getUsdPrice.mockResolvedValue(0.11);

    const result = await worker.refreshPrices();

    expect(result).toEqual({ updated: 2, failed: 0, circuitBroken: false });
    expect(getUsdPrice).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tokenUpdate).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { priceUsd: 0.11 },
    });
    expect(historyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tokenId: "token-1", priceUsd: 0.11 }),
    });
    expect(pause).not.toHaveBeenCalled();
  });

  it("trips the global kill switch when a price moves past the threshold", async () => {
    tokenFindMany.mockResolvedValue([{ id: "token-1", symbol: "XLM", priceUsd: 0.1 }]);
    getUsdPrice.mockResolvedValue(0.2);

    const result = await worker.refreshPrices();

    expect(result.circuitBroken).toBe(true);
    expect(pause).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        reasonCode: "PRICE_FEED_EXTREME_MOVE",
        activatedBy: "price-feed-worker",
      }),
    );
  });

  it("does not persist invalid provider prices", async () => {
    tokenFindMany.mockResolvedValue([{ id: "token-1", symbol: "XLM", priceUsd: null }]);
    getUsdPrice.mockResolvedValue(Number.NaN);

    const result = await worker.refreshPrices();

    expect(result).toEqual({ updated: 0, failed: 1, circuitBroken: false });
    expect(transaction).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("registers as a leader-elected worker", () => {
    worker.onModuleInit();
    expect(registerWorker).toHaveBeenCalledWith("price-feed", expect.any(Function));
    worker.onModuleDestroy();
  });
});