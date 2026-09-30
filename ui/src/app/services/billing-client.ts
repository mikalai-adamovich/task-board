import { Service } from '@angular/core';
import { Observable, of } from 'rxjs';
import { delay } from 'rxjs/operators';

/** Id of the only plan offered during onboarding. */
export const FREE_PLAN_ID = 'free';

/** Result returned by the billing provider after a completed checkout. */
export interface CheckoutResult {
  status: 'active';
  plan: string;
}

/** Context handed to the billing provider when completing a checkout. */
export interface CheckoutContext {
  workspaceName: string;
  slug: string;
}

/**
 * Billing boundary.
 *
 * Isolates the onboarding flow from any concrete billing provider: the mock
 * implementation collects no payment data and resolves locally after a short
 * artificial delay. Replacing it with a real provider must not require any
 * change to the onboarding components.
 */
@Service()
export class BillingClient {
  /**
   * Complete a (mock) checkout for the given plan.
   * No payment data is collected; the result is a simulated active subscription.
   */
  completeMockCheckout(planId: string, context: CheckoutContext): Observable<CheckoutResult> {
    // The mock provider ignores the checkout context; a real provider would use it.
    void context;

    return of({ status: 'active' as const, plan: planId }).pipe(delay(300));
  }
}
