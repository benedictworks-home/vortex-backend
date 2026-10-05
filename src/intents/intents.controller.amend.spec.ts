import { ConfigService } from "@nestjs/config";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { buildAmendMessage } from "../common/stellar-signature";
import { IntentsController } from "./intents.controller";
import { IntentsService } from "./intents.service";
import { Intent } from "./intents.types";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "./intents.gateway";
import { TokensService } from "../tokens/tokens.service";
import { RoutingService } from "../routing/routing.service";
import { KillSwitchService } from "../killswitch/killswitch.service";

describe("IntentsController.amend", () => {
  const keypair = Keypair.random();
  const now = Math.floor(Date.now() / 1000);
  const intent: Intent = {
    intentId: "amend-test-id",
    user: keypair.publicKey(),
    srcChain: "ethereum",
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000",
    dstToken: { contract: "CTEST", symbol: "USDC", decimals: 7 },
    minDstAmount: "900",
    state: "open",
    createdAt: now - 60,
    deadline: now + 600,
  };

  function setup(current = intent) {
    const amended: Intent = { ...current, minDstAmount: "850", deadline: now + 900 };
    const service = {
      get: jest.fn().mockResolvedValue(current),
      amendIfOpen: jest.fn().mockResolvedValue(amended),
      appendAuditEntry: jest.fn(),
    } as unknown as jest.Mocked<IntentsService>;
    const config = { get: jest.fn().mockReturnValue([]) } as unknown as ConfigService<AppConfig, true>;
    const controller = new IntentsController(
      service,
      {} as SolversService,
      {} as IntentsGateway,
      {} as TokensService,
      {} as RoutingService,
      {} as KillSwitchService,
      config,
    );
    const dto = {
      user: keypair.publicKey(),
      minDstAmount: "850",
      deadline: now + 900,
      signature: keypair
        .sign(Buffer.from(buildAmendMessage(intent.intentId, keypair.publicKey(), "850", now + 900)))
        .toString("base64"),
    };
    return { controller, service, amended, dto };
  }

  it("applies both signed replacement terms and appends amendment history", async () => {
    const { controller, service, amended, dto } = setup();

    await expect(controller.amend(intent.intentId, dto)).resolves.toBe(amended);
    expect(service.amendIfOpen).toHaveBeenCalledWith(intent.intentId, {
      minDstAmount: "850",
      deadline: now + 900,
    });
    expect(service.appendAuditEntry).toHaveBeenCalledWith(
      intent.intentId,
      "open",
      keypair.publicKey(),
      "user amended",
      {
        previousMinDstAmount: "900",
        minDstAmount: "850",
        previousDeadline: intent.deadline,
        deadline: now + 900,
      },
    );
  });

  it("rejects a request signed by an address other than the intent owner", async () => {
    const { controller, service, dto } = setup();

    await expect(controller.amend(intent.intentId, { ...dto, user: Keypair.random().publicKey() }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(service.amendIfOpen).not.toHaveBeenCalled();
  });

  it("rejects a signature that does not cover the replacement values", async () => {
    const { controller, service, dto } = setup();

    await expect(controller.amend(intent.intentId, { ...dto, minDstAmount: "851" }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.amendIfOpen).not.toHaveBeenCalled();
  });
});