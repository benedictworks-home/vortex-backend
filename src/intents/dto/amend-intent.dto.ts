import { IsInt, IsString, Matches, MaxLength, Min, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { IsValidDeadline } from "../../common/validators/deadline.validator";

const ED25519_SIGNATURE_MAX_LENGTH = 88;

export class AmendIntentDto {
  @ApiProperty({ description: "Stellar address of the intent's original creator (must match)", maxLength: 56 })
  @IsString()
  @MinLength(10)
  @MaxLength(56)
  user!: string;

  @ApiProperty({ description: "Replacement minimum destination amount in base units" })
  @IsString()
  @Matches(/^\d+$/)
  minDstAmount!: string;

  @ApiProperty({ description: "Replacement Unix timestamp deadline" })
  @IsInt()
  @Min(1)
  @IsValidDeadline()
  deadline!: number;

  @ApiProperty({
    description: 'Base64 Ed25519 signature of "amend:<intentId>:<user>:<minDstAmount>:<deadline>"',
    maxLength: ED25519_SIGNATURE_MAX_LENGTH,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(ED25519_SIGNATURE_MAX_LENGTH)
  signature!: string;
}