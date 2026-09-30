import { ApiProperty } from "@nestjs/swagger";
import { IsDefined, IsString, MinLength } from "class-validator";

/**
 * Body for `POST /api/v1/auth/token` (issue #442): the server-issued SEP-10
 * challenge transaction, signed by the client account, as base64 XDR. The
 * client account is read from the transaction itself; the exchange rejects
 * challenges whose client account does not exist on the network or whose
 * signer weight does not meet the account threshold.
 */
export class AuthTokenDto {
  @ApiProperty({
    description: "Base64 XDR of the SEP-10 challenge transaction, signed by the client account",
    example: "AAAAAgAAAAB...",
  })
  @IsDefined({ message: "transaction is required" })
  @IsString()
  @MinLength(64)
  transaction!: string;
}
