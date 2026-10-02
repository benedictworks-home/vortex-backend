import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import * as fs from "fs";
import * as path from "path";

/**
 * Serves the AsyncAPI specification for the Vortex WebSocket feed (issue #456).
 *
 * The document lives at `docs/asyncapi.yaml` in the repository root and is
 * served verbatim so that tooling (AsyncAPI Studio, SDK generators, CI schema
 * validation) can consume it without a build step.
 */
@ApiTags("docs")
@Controller("docs/ws")
export class WsDocsController {
  private readonly specContent: string;

  constructor() {
    // Resolve relative to the project root regardless of cwd or dist/ location.
    const candidates = [
      path.resolve(process.cwd(), "docs", "asyncapi.yaml"),
      path.resolve(__dirname, "..", "..", "..", "docs", "asyncapi.yaml"),
      path.resolve(__dirname, "..", "..", "docs", "asyncapi.yaml"),
    ];

    let content: string | null = null;
    for (const p of candidates) {
      try {
        content = fs.readFileSync(p, "utf8");
        break;
      } catch {
        // try next candidate
      }
    }

    this.specContent = content ?? "# AsyncAPI spec not found";
  }

  @Get()
  @Header("Content-Type", "application/x-yaml; charset=utf-8")
  @Header("Cache-Control", "public, max-age=3600")
  @ApiOperation({
    summary: "AsyncAPI specification for the Vortex WebSocket feed",
    description:
      "Returns the AsyncAPI 2.6 YAML document describing the vortex.v1 subprotocol. " +
      "Use this with AsyncAPI Studio or SDK generators.",
  })
  getSpec(): string {
    return this.specContent;
  }
}
