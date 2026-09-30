import { ApiProperty } from "@nestjs/swagger";
import { IsNumber, IsString } from "class-validator";

/**
 * Body of `POST /api/v1/solvers/:address/heartbeat` (issue #445): a fresh,
 * signed proof that the solver process is still running. The WebSocket
 * `{ "type": "heartbeat" }` message is the primary channel — this REST
 * route exists for clients without a persistent connection.
 */
export class HeartbeatDto {
  @ApiProperty({
    description: "Unix timestamp (seconds) at which this heartbeat was signed",
    example: 1759248000,
  })
  @IsNumber()
  timestamp!: number;

  @ApiProperty({
    description: "Base64 Ed25519 signature over `heartbeat:<address>:<timestamp>`",
    example: "base64EncodedSignatureOverHeartbeatMessage==",
  })
  @IsString()
  signature!: string;
}
