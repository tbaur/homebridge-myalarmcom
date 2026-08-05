/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Low-level HTTP transport shared by authentication and the API client.
 */
/**
 * Identifies the plugin honestly rather than impersonating a browser.
 *
 * Verified acceptable: Alarm.com served the full API surface under this during
 * probe runs. If it ever starts refusing non-browser agents, that is a
 * deliberate signal from them and spoofing it would be the wrong response.
 *
 * The version is read from `package.json` rather than written here. A hardcoded
 * one silently went thirteen releases stale, which defeats the point of
 * identifying honestly and makes a bad release impossible to correlate.
 */
export declare const USER_AGENT: string;
/** Options accepted by {@link httpRequest}, mirroring a subset of `RequestInit`. */
export interface HttpRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | URLSearchParams;
    timeoutMs?: number;
    /** Cancels the request, and its body read, on shutdown. */
    signal?: AbortSignal;
    /**
     * Redirects are not followed by default.
     *
     * Alarm.com sets session cookies on the 302 hops of the login flow, and the
     * fetch API only exposes `Set-Cookie` from the final response. Following
     * redirects automatically silently discards those cookies.
     */
    redirect?: 'follow' | 'manual' | 'error';
}
/**
 * A completed HTTP exchange, body included.
 *
 * The body is part of the result rather than a promise the caller resolves
 * later, because that is what makes the deadline mean anything: `fetch` settles
 * as soon as headers arrive, so a caller reading `response.text()` afterwards
 * does so with no timeout at all and a stalled body hangs forever.
 */
export interface HttpResponse {
    status: number;
    ok: boolean;
    headers: Headers;
    text: string;
}
/**
 * Perform an HTTP request with a hard timeout and consistent identification.
 *
 * @throws {TimeoutError} The request or its body read exceeded the deadline.
 * @throws {OperationAbortedError} The caller's signal aborted the request.
 * @throws {NetworkError} The request failed below the HTTP layer.
 */
export declare function httpRequest(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
//# sourceMappingURL=http.d.ts.map