import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthChallengeQueryDto } from "./dto/auth-challenge.query.dto";
import { AuthTokenDto } from "./dto/auth-token.dto";
import { Sep10Service } from "./sep10.service";

/**
 * SEP-10-style challenge authentication (issue #442).
 *
 * `GET /api/v1/auth/challenge?account=G...` issues the server-signed
 * challenge; `POST /api/v1/auth/token` exchanges the client-signed challenge
 * for a 15-minute EdDSA session JWT used as a Bearer token on REST and as
 * the handshake/first-message token on the WebSocket gateway.
 */
@ApiTags("auth")
@Controller("api/v1/auth")
export class Sep10Controller {
  constructor(private readonly sep10: Sep10Service) {}

  /**
   * Issues a SEP-10 challenge transaction bound to this server (home domain,
   * `web_auth_domain` operation, single-use nonce, 5-minute time bounds).
   */
  @Get("challenge")
  @ApiOperation({
    summary: "Issue a SEP-10 challenge transaction",
    description:
      "Returns a base64 challenge transaction for the given Stellar account. " +
      "Sign it with the account's key(s) and POST it to /api/v1/auth/token.",
  })
  @ApiOkResponse({ description: "Challenge transaction issued" })
  @ApiBadRequestResponse({ description: "account is not a valid Stellar G-address" })
  challenge(@Query() query: AuthChallengeQueryDto) {
    return this.sep10.buildChallenge(query.account);
  }

  /**
   * Exchanges a signed challenge for the short-lived session JWT. A challenge
   * can be exchanged exactly once; refreshing means re-running the flow.
   */
  @Post("token")
  @HttpCode(200)
  @ApiOperation({
    summary: "Exchange a signed SEP-10 challenge for a session JWT",
    description:
      "Verifies the server signature, time bounds, home domain, client signature " +
      "weight against the account threshold, and the single-use nonce, then " +
      "returns a 15-minute EdDSA JWT with `sub` and `role` claims.",
  })
  @ApiOkResponse({ description: "Session JWT issued" })
  @ApiBadRequestResponse({ description: "challenge failed verification or was already used" })
  token(@Body() dto: AuthTokenDto) {
    return this.sep10.exchange(dto.transaction);
  }
}
