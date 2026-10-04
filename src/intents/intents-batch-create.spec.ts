import { ConfigService } from "@nestjs/config";
import { BadRequestException, UnprocessableEntityException } from "@nestjs/common";
import { IntentsService, NewIntentData, MAX_OPEN_INTENTS_PER_USER } from "./intents.service";
import { InMemoryIntentsRepository } from "./intents.repository";
import { StellarTxService } from "../soroban/stellar-tx.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfig } from "../config/configuration";
import { ProtocolParamsService } from "../governance/params.service";
import { BATCH_CREATE_MAX_INTENTS } from "../config/limits.config";
import { IntentsController } from "./intents.controller";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "./intents.gateway";
import { TokensService } from "../tokens/tokens.service";
import { RoutingService } from "../routing/routing.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { CreateIntentDto } from "./dto/create-intent.dto";

describe("IntentsService.createBatch & IntentsController.batchCreate (#429)", () => {
  let service: IntentsService;
  let repo: InMemoryIntentsRepository;
  let controller: IntentsController;

  beforeEach(() => {
    repo = new InMemoryIntentsRepository();
    const config = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === "canaryAddresses") return [];
        return false;
      }),
    } as unknown as ConfigService<AppConfig, true>;
    const stellarTx = {} as StellarTxService;
    const prisma = {
      intentAuditLog: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const protocolParams = {
      snapshotForChain: jest.fn().mockReturnValue({
        version: 0,
        feeBps: 30,
        deadlineSeconds: 1800,
        fillWindowSeconds: 600,
        capturedAt: new Date().toISOString(),
      }),
    } as unknown as ProtocolParamsService;

    service = new IntentsService(repo, config, stellarTx, prisma, protocolParams);

    const solversService = {
      getAll: jest.fn().mockResolvedValue([]),
    } as unknown as SolversService;
    const intentsGateway = {
      broadcast: jest.fn(),
    } as unknown as IntentsGateway;
    const tokensService = {
      resolveSrcTokenOrThrow: jest.fn().mockImplementation((chain, addr) =>
        Promise.resolve({ address: addr, symbol: "USDC", name: "USD Coin", decimals: 6, chain, priceUSD: 1 }),
      ),
      resolveDstTokenOrThrow: jest.fn().mockImplementation((contract) =>
        Promise.resolve({ contract, symbol: "USDC", decimals: 7, priceUSD: 1 }),
      ),
    } as unknown as TokensService;
    const routingService = {} as RoutingService;
    const killSwitch = {
      isPaused: jest.fn().mockReturnValue(false),
    } as unknown as KillSwitchService;

    controller = new IntentsController(
      service,
      solversService,
      intentsGateway,
      tokensService,
      routingService,
      killSwitch,
      config,
    );
  });

  function makeItem(user = "GBATCHUSER0000000000000000000000000000000000000000000001"): NewIntentData {
    return {
      user,
      srcChain: "ethereum",
      srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
      srcAmount: "1000000",
      dstToken: { contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", symbol: "USDC", decimals: 7 },
      minDstAmount: "990000",
      deadline: Math.floor(Date.now() / 1000) + 1800,
    };
  }

  function makeDto(user = "GBATCHUSER0000000000000000000000000000000000000000000001"): CreateIntentDto {
    return {
      user,
      srcChain: "ethereum",
      srcTokenAddress: "0xabc",
      srcTokenSymbol: "USDC",
      srcTokenDecimals: 6,
      srcAmount: "1000000",
      dstTokenContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      dstTokenSymbol: "USDC",
      dstTokenDecimals: 7,
      minDstAmount: "990000",
      deadline: Math.floor(Date.now() / 1000) + 1800,
    };
  }

  describe("Service layer", () => {
    it("successfully creates multiple intents atomically", async () => {
      const initialRepoCount = (await repo.findAll()).length;
      const item1 = makeItem("GUSER111111111111111111111111111111111111111111111111");
      const item2 = makeItem("GUSER222222222222222222222222222222222222222222222222");

      const result = await service.createBatch([item1, item2]);

      expect(result.errors).toHaveLength(0);
      expect(result.created).toHaveLength(2);
      expect(result.created[0].user).toBe(item1.user);
      expect(result.created[1].user).toBe(item2.user);

      const all = await repo.findAll();
      expect(all).toHaveLength(initialRepoCount + 2);
    });

    it("enforces atomicity: if any item exceeds user open intent cap, zero intents are created", async () => {
      const user = "GUSEROVERCAP00000000000000000000000000000000000000000";

      for (let i = 0; i < MAX_OPEN_INTENTS_PER_USER - 1; i++) {
        await service.create(makeItem(user));
      }

      const initialRepoCount = (await repo.findAll()).length;

      const item1 = makeItem(user);
      const item2 = makeItem(user);

      const result = await service.createBatch([item1, item2]);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.created).toHaveLength(0);
      expect(result.errors[0].index).toBe(1);
      expect(result.errors[0].field).toBe("user");
      expect(result.errors[0].message).toContain("Open-intent cap reached");

      const finalRepoCount = (await repo.findAll()).length;
      expect(finalRepoCount).toBe(initialRepoCount);
    });

    it("handles multiple users and aggregates open counts across items in the batch", async () => {
      const userA = "GUSERA00000000000000000000000000000000000000000000000";
      const userB = "GUSERB00000000000000000000000000000000000000000000000";

      const items = [makeItem(userA), makeItem(userB), makeItem(userA)];

      const result = await service.createBatch(items);

      expect(result.errors).toHaveLength(0);
      expect(result.created).toHaveLength(3);
    });
  });

  describe("Controller endpoint POST /api/v1/intents/batch-create", () => {
    it("returns created intents for a valid batch", async () => {
      const dto = {
        intents: [
          makeDto("GCTRLUSER100000000000000000000000000000000000000000"),
          makeDto("GCTRLUSER200000000000000000000000000000000000000000"),
        ],
      };

      const res = await controller.batchCreate(dto);

      expect(res.created).toHaveLength(2);
      expect(res.errors).toHaveLength(0);
    });

    it("throws BadRequestException when intents array is empty", async () => {
      await expect(controller.batchCreate({ intents: [] })).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when batch size exceeds limit of 50", async () => {
      const tooMany = Array.from({ length: BATCH_CREATE_MAX_INTENTS + 1 }, () => makeDto());
      await expect(controller.batchCreate({ intents: tooMany })).rejects.toThrow(BadRequestException);
    });

    it("throws UnprocessableEntityException (422) with per-item errors when atomicity fails", async () => {
      const user = "GCTRLOVERCAP0000000000000000000000000000000000000000";
      for (let i = 0; i < MAX_OPEN_INTENTS_PER_USER - 1; i++) {
        await service.create(makeItem(user));
      }

      const dto = {
        intents: [makeDto(user), makeDto(user)],
      };

      try {
        await controller.batchCreate(dto);
        fail("Should have thrown UnprocessableEntityException");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(UnprocessableEntityException);
        const unproc = err as UnprocessableEntityException;
        const response = unproc.getResponse() as { statusCode: number; errors: { index: number; message: string }[] };
        expect(response.statusCode).toBe(422);
        expect(response.errors).toHaveLength(1);
        expect(response.errors[0].index).toBe(1);
      }
    });
  });
});
