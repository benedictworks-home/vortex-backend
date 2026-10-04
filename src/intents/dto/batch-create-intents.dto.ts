import { ArrayMaxSize, ArrayMinSize, IsArray, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { BATCH_CREATE_MAX_INTENTS } from "../../config/limits.config";
import { CreateIntentDto } from "./create-intent.dto";
import { Intent } from "../intents.types";

export class BatchCreateIntentsDto {
  @ApiProperty({
    type: [CreateIntentDto],
    description: `List of intents to create atomically (1..${BATCH_CREATE_MAX_INTENTS})`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BATCH_CREATE_MAX_INTENTS)
  @ValidateNested({ each: true })
  @Type(() => CreateIntentDto)
  intents!: CreateIntentDto[];
}

export class BatchCreateItemErrorDto {
  @ApiProperty({ description: "Zero-based index of the failed intent item in the input array" })
  index!: number;

  @ApiPropertyOptional({ description: "Field name associated with the error, if applicable" })
  field?: string;

  @ApiProperty({ description: "Human-readable error description" })
  message!: string;
}

export class BatchCreateIntentsResponseDto {
  @ApiProperty({ description: "Array of created Intent objects when successful" })
  created!: Intent[];

  @ApiProperty({ type: [BatchCreateItemErrorDto], description: "List of per-item validation errors if any failed" })
  errors!: BatchCreateItemErrorDto[];
}
