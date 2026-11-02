import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
  ApiConfiguration,
  disputeReview,
  getReview,
  getWeeklyPerformance,
  listReviewDigests,
  listReviews,
  type GetWeeklyPerformance$Params,
  type ListReviewDigests$Params,
  type ListReviews$Params,
  type StrictHttpResponse,
} from './generated';

const body = <T>(response: Observable<StrictHttpResponse<T>>) => response.pipe(map((r) => r.body));

/** Rendimiento (tarea 026): métricas semanales, revisiones de calidad y resúmenes semanales. */
@Injectable({ providedIn: 'root' })
export class PerformanceApi {
  private readonly http = inject(HttpClient);
  private readonly rootUrl = inject(ApiConfiguration).rootUrl;

  weekly(params: GetWeeklyPerformance$Params) {
    return body(getWeeklyPerformance(this.http, this.rootUrl, params));
  }

  reviews(params: ListReviews$Params) {
    return body(listReviews(this.http, this.rootUrl, params));
  }

  review(id: string) {
    return body(getReview(this.http, this.rootUrl, { id }));
  }

  /** "No es correcta". Idempotente. */
  dispute(id: string, note: string) {
    return body(disputeReview(this.http, this.rootUrl, { id, body: note ? { note } : {} }));
  }

  digests(params: ListReviewDigests$Params) {
    return body(listReviewDigests(this.http, this.rootUrl, params));
  }
}
