import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Generic keyset-pagination envelope (#412).
 *
 * Wraps any list result with a `nextCursor` that clients pass back as
 * `?cursor=` on the next request.  A null `nextCursor` means the caller
 * has reached the last page.
 *
 * The `Deprecation` header is added by the controller when a request
 * arrived with an `offset` query parameter (see #412 acceptance criteria).
 *
 * @template T  The type of each item in the page.
 */
export class PaginatedResponse<T> {
  @ApiProperty({ description: "Items in this page" })
  data!: T[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "Opaque cursor for the next page. Pass as `?cursor=` on the next request. " +
      "Null when this is the last page.",
  })
  nextCursor!: string | null;

  @ApiProperty({ description: "Number of items returned in this page" })
  count!: number;

  constructor(data: T[], nextCursor: string | null) {
    this.data = data;
    this.nextCursor = nextCursor;
    this.count = data.length;
  }
}
