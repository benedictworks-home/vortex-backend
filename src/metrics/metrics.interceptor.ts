import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, finalize } from "rxjs";
import { MetricsService } from "./metrics.service";
import { getApiVersionFromUrl } from "../common/api-versioning";

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const start = Date.now();
    const method = request.method;
    const route = request.route?.path || request.originalUrl || request.url || "unknown";
    const apiVersion = getApiVersionFromUrl(request.originalUrl ?? request.url ?? "");
    const version = apiVersion === "unversioned" ? apiVersion : `v${apiVersion}`;

    return next.handle().pipe(
      // finalize (not tap) so 5xx thrown as exceptions are still counted.
      finalize(() => {
        const statusCode = response.statusCode ?? 500;
        const duration = (Date.now() - start) / 1000;

        const labels = { method, route, status_code: statusCode, version };
        this.metricsService.httpRequestTotal.inc(labels);
        this.metricsService.httpRequestDuration.observe(labels, duration);
        if (statusCode >= 500) {
          this.metricsService.httpRequestErrors.inc(labels);
        }
        if (apiVersion === "1" && method === "POST" && /^\/api\/v1\/intents(?:\?|$)/.test(request.originalUrl ?? "")) {
          this.metricsService.observeIntentCreate(duration);
        }
      }),
    );
  }
}
