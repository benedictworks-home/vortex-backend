import { ApiProperty } from "@nestjs/swagger";
import { IsDefined, Matches } from "class-validator";

/**
 * Query string for `GET /api/v1/auth/challenge` (issue #442): the Stellar
 * account that wants a SEP-10 challenge. Only G-addresses are accepted —
 * muxed accounts and non-Stellar identifiers are out of scope for solver
 * authentication.
 */
export class AuthChallengeQueryDto {
  @ApiProperty({
    description: "Stellar account (G-address) requesting the challenge",
    example: "GCEZWKCA3VHXBUJ4FBU6K3ZV4QX5Y4QZ4Y4QX5Y4QX5Y4QX5Y4QX5Y4Q",
  })
  @IsDefined({ message: "account query parameter is required" })
  @Matches(/^G[A-Z2-7]{55}$/, { message: "account must be a Stellar G-address" })
  account!: string;
}
