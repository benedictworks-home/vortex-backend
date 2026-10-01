import { INestApplication, VersioningType } from "@nestjs/common";
import { OpenAPIObject } from "@nestjs/swagger";
import { Request, RequestHandler, Response } from "express";

export const API_VERSION_PREFIX = "api/v";
export const API_VERSIONS = ["1", "2"] as const;

export interface ApiVersionLifecycle {
  deprecatedAt?: string;
  sunsetAt?: string;
  deprecationLink?: string;
}

export function enableApiVersioning(app: INestApplication): void {
  app.enableVersioning({
    type: VersioningType.URI,
    prefix: API_VERSION_PREFIX,
  });
}

export function getApiVersionFromUrl(url: string): string {
  return url.match(/^\/api\/v(\d+)(?:\/|\?|$)/)?.[1] ?? "unversioned";
}

export function openApiDocumentForVersion(document: OpenAPIObject, version: string): OpenAPIObject {
  const versionPath = `/api/v${version}`;
  const paths = Object.fromEntries(
    Object.entries(document.paths).filter(
      ([path]) => path === versionPath || path.startsWith(`${versionPath}/`),
    ),
  );

  return {
    ...document,
    info: { ...document.info, version },
    paths,
  };
}

function readVersionLifecycleFromEnvironment(): Record<string, ApiVersionLifecycle> {
  return {
    "1": {
      deprecatedAt: process.env.API_V1_DEPRECATED_AT,
      sunsetAt: process.env.API_V1_SUNSET_AT,
      deprecationLink: process.env.API_V1_DEPRECATION_LINK,
    },
  };
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

export function createApiDeprecationHeadersMiddleware(
  lifecycle: Record<string, ApiVersionLifecycle> = readVersionLifecycleFromEnvironment(),
): RequestHandler {
  return (request: Request, response: Response, next) => {
    const version = getApiVersionFromUrl(request.path);
    const policy = lifecycle[version];
    if (!policy) return next();

    const deprecatedAt = parseDate(policy.deprecatedAt);
    const sunsetAt = parseDate(policy.sunsetAt);
    if (deprecatedAt) {
      response.setHeader("Deprecation", `@${Math.floor(deprecatedAt.getTime() / 1000)}`);
    }
    if (sunsetAt) response.setHeader("Sunset", sunsetAt.toUTCString());
    if (policy.deprecationLink) {
      response.setHeader("Link", `<${policy.deprecationLink}>; rel="deprecation"`);
    }

    next();
  };
}