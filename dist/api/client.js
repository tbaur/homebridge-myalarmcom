"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Typed client for the Alarm.com JSON:API surface.
 *
 * Every attempt passes through pacing and then the circuit breaker. Retry wraps
 * the whole thing, so a retried attempt is re-paced and re-checked against the
 * breaker rather than bypassing them — which is what stops retry amplifying a
 * problem. Session establishment sits outside all three: it has its own floor,
 * and counting a login as request latency made the reported percentiles
 * meaningless.
 */
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlarmComClient = void 0;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const retry_1 = require("../utils/retry");
const sanitizers_1 = require("../utils/sanitizers");
const circuit_breaker_1 = require("./circuit-breaker");
const http_1 = require("./http");
const rate_limiter_1 = require("./rate-limiter");
/** Width of a correlation tag: short enough to scan, wide enough not to collide. */
const REQUEST_TAG_HEX_DIGITS = 6;
/**
 * A short tag identifying one logical request.
 *
 * Alarm.com is polled every interval and each poll is several requests, so a
 * log can hold thousands of near-identical lines a day. Without a tag there is
 * no way to tell which retry, which session recovery, and which failure belong
 * to the same request. Six hex characters is plenty to disambiguate within one
 * log; it is not an identifier anything depends on.
 */
function nextRequestTag() {
    const value = Math.floor(Math.random() * 16 ** REQUEST_TAG_HEX_DIGITS);
    return value.toString(16).padStart(REQUEST_TAG_HEX_DIGITS, '0');
}
/** Split a list into chunks no larger than the API will accept. */
function chunkIds(ids, size = settings_1.MAX_IDS_PER_REQUEST) {
    const chunks = [];
    for (let index = 0; index < ids.length; index += size) {
        chunks.push(ids.slice(index, index + size));
    }
    return chunks;
}
/** Build a batched collection URL with `ids[]` parameters. */
function buildBatchUrl(baseUrl, ids) {
    const params = ids.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
    return `${baseUrl}?${params}`;
}
/** Whether a JSON:API linkage carries a usable resource id. */
function isUsableId(value) {
    return typeof value === 'string' && value.length > 0;
}
/** Both ways a lapsed session announces itself. Safe to replay a *read* on. */
function isLapsedSession(error) {
    return error instanceof errors_1.SessionExpiredError || error instanceof errors_1.ApiParseError;
}
/**
 * The only failure a non-idempotent write may be replayed on.
 *
 * A 401 means the request was rejected outright, so a replay sends the command
 * for the first time. Nothing else qualifies.
 */
function isRejectedOutright(error) {
    return error instanceof errors_1.SessionExpiredError;
}
/**
 * Extract the linkage list from a JSON:API relationship.
 *
 * Ids are filtered rather than trusted. Responses are parsed without runtime
 * validation, and a malformed linkage previously produced `[undefined]`, which
 * became the literal query parameter `ids[]=undefined` and a handler keyed on
 * the string `"undefined"`.
 */
function readRelationshipIds(resource, name) {
    const data = resource?.relationships?.[name]?.data;
    const identifiers = Array.isArray(data)
        ? data
        : data
            ? [data]
            : [];
    return identifiers.map((entry) => entry.id).filter(isUsableId);
}
/** Reads and commands Alarm.com devices. */
class AlarmComClient {
    #sessionManager;
    #log;
    #breaker;
    #limiter;
    #metrics;
    #onThrottle;
    #onRetry;
    #signal;
    /** Whether the current outage has already been announced. */
    #hasReportedCircuitOpen = false;
    constructor(options) {
        this.#sessionManager = options.sessionManager;
        this.#log = options.log;
        this.#metrics = options.metrics;
        this.#onThrottle = options.onThrottle;
        this.#onRetry = options.onRetry;
        this.#signal = options.signal;
        this.#breaker = options.circuitBreaker ?? new circuit_breaker_1.CircuitBreaker();
        this.#breaker.attachOnStateChange((from, to) => {
            // Once per outage, not once per probe cycle. The breaker re-opens after
            // every failed half-open probe, so counting each as a trip reported 1,440
            // of them for a single day-long outage.
            const isNewOutage = to === circuit_breaker_1.CircuitState.OPEN && !this.#hasReportedCircuitOpen;
            this.#logCircuitTransition(from, to);
            if (isNewOutage) {
                options.onCircuitOpen?.();
            }
        });
        this.#limiter = options.rateLimiter ?? new rate_limiter_1.RateLimiter();
    }
    /**
     * Surface circuit-breaker transitions as bare `from -> to` lines.
     *
     * Only the edges into and out of "unavailable" are loud. During an outage the
     * breaker necessarily flaps OPEN -> HALF_OPEN -> OPEN once per poll cycle as
     * the cooldown elapses and the probe fails, which at the default interval was
     * 2,880 lines a day — arriving at warn level, in the log an operator is
     * scrolling to understand the outage, burying the one line that explains it.
     */
    #logCircuitTransition(from, to) {
        const message = `Circuit breaker ${from} -> ${to}`;
        if (to === circuit_breaker_1.CircuitState.OPEN && !this.#hasReportedCircuitOpen) {
            this.#hasReportedCircuitOpen = true;
            this.#log.warn(message);
            return;
        }
        if (to === circuit_breaker_1.CircuitState.CLOSED && this.#hasReportedCircuitOpen) {
            this.#hasReportedCircuitOpen = false;
            this.#log.info(message);
            return;
        }
        this.#log.debug(message);
    }
    /**
     * Issue one authenticated request and parse the JSON:API response.
     *
     * Takes the session rather than resolving it, so establishing one — which can
     * wait on the login floor, and is two requests of its own — is neither timed
     * as request latency nor charged against the pacing budget for this call.
     */
    async #send(session, url, options = {}) {
        const { method = 'GET', body, tag = nextRequestTag(), signal = this.#signal } = options;
        const headers = {
            Accept: settings_1.JSON_API_ACCEPT,
            Cookie: session.cookieHeader,
            [settings_1.CSRF_HEADER_NAME]: session.ajaxKey,
            Referer: settings_1.HOME_REFERER,
        };
        if (body !== undefined) {
            headers['Content-Type'] = settings_1.JSON_API_ACCEPT;
        }
        const startedAt = Date.now();
        const response = await (0, http_1.httpRequest)(url, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            ...(signal ? { signal } : {}),
        });
        const durationMs = Date.now() - startedAt;
        if (!response.ok) {
            const retryAfterMs = (0, errors_1.parseRetryAfterMs)(response.headers.get('retry-after'));
            throw (0, errors_1.createApiError)(response.status, `Alarm.com returned ${response.status} for ${(0, sanitizers_1.sanitizeUrl)(url)} [${tag}, ${durationMs}ms]`, {
                body: response.text,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            });
        }
        this.#log.debug(`${method} ${(0, sanitizers_1.sanitizeUrl)(url)} -> ${response.status} [${tag}, ${durationMs}ms]`);
        try {
            return JSON.parse(response.text);
        }
        catch (error) {
            // Alarm.com serves an HTML login page rather than a JSON error when a
            // session lapses, so an unparseable body usually means "sign in again".
            throw new errors_1.ApiParseError(`Alarm.com returned a non-JSON response for ${(0, sanitizers_1.sanitizeUrl)(url)} [${tag}]; the session may have expired`, error instanceof Error ? { cause: error } : undefined);
        }
    }
    /**
     * One guarded attempt: timed, paced, and behind the circuit breaker.
     *
     * The session is resolved first and outside all three, so a login's own two
     * requests and any login-floor wait are not attributed to this call.
     */
    #guardedAttempt(url, options) {
        const signal = options.signal ?? this.#signal;
        return async () => {
            const session = await this.#sessionManager.getSession();
            return this.#timedAttempt(() => this.#limiter.execute(() => this.#breaker.execute(() => this.#send(session, url, options)), signal));
        };
    }
    /**
     * Run an attempt, recovering from a lapsed session exactly once.
     *
     * Beyond one recovery it propagates, because repeatedly re-authenticating
     * against a service that keeps rejecting us is how accounts get locked.
     *
     * A lapsed session announces itself two ways: a 401, and an HTTP 200 carrying
     * the HTML login page, which fails to parse. Treating only the 401 as expiry
     * meant the HTML case kept reusing dead cookies until the auth interval
     * elapsed, turning a one-request recovery into minutes of failing polls.
     *
     * @param isReplayable Which failures may be retried. A read may replay on
     *   either signal. A *write* may only replay on the 401: an `ApiParseError` is
     *   thrown after `response.ok`, so it means the panel very likely accepted the
     *   command and Alarm.com answered with an interstitial — replaying it sends a
     *   second arm.
     */
    async #withSessionRecovery(attempt, context, isReplayable = isLapsedSession) {
        try {
            return await attempt();
        }
        catch (error) {
            if (isReplayable(error)) {
                this.#log.debug(`session rejected ${context}: re-authenticating once before giving up`);
                this.#sessionManager.invalidate();
                return attempt();
            }
            throw error;
        }
    }
    /**
     * Whether a failure is worth another generic attempt.
     *
     * Narrower than {@link AlarmComError.isRetryable}, which answers "may this
     * clear on its own?". Three exclusions, each for its own reason:
     *
     * - Session lapses have their own one-shot recovery above, and must not also
     *   be retried three times.
     * - An open circuit must fail fast rather than burn paced attempts against a
     *   service already known to be unavailable.
     * - A login throttle carries a wait of up to the whole re-auth interval.
     *   Retrying sleeps it inline, which is exactly what the session manager's
     *   inline-wait cap exists to prevent; the next poll is the right place to
     *   try again.
     */
    static #isWorthRetrying(error) {
        if (isLapsedSession(error)
            || error instanceof errors_1.CircuitBreakerError
            || error instanceof errors_1.LoginThrottledError) {
            return false;
        }
        return error instanceof errors_1.AlarmComError && error.isRetryable;
    }
    /** Send a request under pacing, the circuit breaker, and retry. */
    async #request(url, options = {}) {
        const tag = options.tag ?? nextRequestTag();
        const signal = options.signal ?? this.#signal;
        const attempt = this.#guardedAttempt(url, { ...options, tag });
        return (0, retry_1.withRetry)(() => this.#withSessionRecovery(attempt, `[${tag}]`), {
            isRetryable: _a.#isWorthRetrying,
            onRetry: (attemptNumber, delayMs, error) => {
                this.#onRetry?.();
                this.#log.debug(`retrying ${(0, sanitizers_1.sanitizeUrl)(url)} [${tag}] (attempt ${attemptNumber}) in ${delayMs}ms after ${(0, sanitizers_1.sanitizeError)(error)}`);
            },
            ...(signal ? { signal } : {}),
        });
    }
    /**
     * Time one attempt and feed the outcome to diagnostics.
     *
     * Pre-flight rejections (open breaker, pacing refusal) are recorded as
     * non-networked so they do not skew latency percentiles.
     */
    async #timedAttempt(operation) {
        const started = Date.now();
        try {
            const result = await operation();
            this.#metrics?.({ durationMs: Date.now() - started, isOk: true, wasNetworked: true });
            return result;
        }
        catch (error) {
            const isThrottle = error instanceof errors_1.RequestPacingError;
            const isBreaker = error instanceof errors_1.CircuitBreakerError;
            if (isThrottle) {
                this.#onThrottle?.();
            }
            this.#metrics?.({
                durationMs: Date.now() - started,
                isOk: false,
                wasNetworked: !isThrottle && !isBreaker,
            });
            throw error;
        }
    }
    /** Resolve the system this account has selected. */
    async getSystemId(signal) {
        const response = await this.#request(settings_1.IDENTITIES_URL, signal ? { signal } : {});
        const identity = response.data?.[0];
        const selected = identity?.relationships?.selectedSystem?.data;
        if (!selected || Array.isArray(selected) || !isUsableId(selected.id)) {
            // Distinct from ConfigurationError, which means the *user's* config is
            // wrong and only they can fix it. This is Alarm.com not reporting a
            // system, which is usually an account setup problem but is also what a
            // partial response looks like — so it is retried on a backoff instead of
            // permanently ending startup.
            throw new errors_1.SystemUnavailableError('Alarm.com did not report a selected system for this account');
        }
        return selected.id;
    }
    /** List the partition and sensor IDs belonging to a system. */
    async getSystemDevices(systemId, signal) {
        const url = `${settings_1.SYSTEM_URL}${encodeURIComponent(systemId)}`;
        const response = await this.#request(url, signal ? { signal } : {});
        return {
            partitionIds: readRelationshipIds(response.data, 'partitions'),
            sensorIds: readRelationshipIds(response.data, 'sensors'),
        };
    }
    /** Fetch a collection in batches the API will accept. */
    async #getBatched(baseUrl, ids, signal) {
        if (ids.length === 0) {
            return [];
        }
        const results = [];
        // Sequential, not parallel: concurrent bursts are what the pacing exists to
        // prevent, and discovery is not latency-sensitive.
        for (const chunk of chunkIds(ids)) {
            const response = await this.#request(buildBatchUrl(baseUrl, chunk), signal ? { signal } : {});
            results.push(...(response.data ?? []));
        }
        return results;
    }
    /** Read the current state of the given sensors. */
    async getSensors(ids, signal) {
        return this.#getBatched(settings_1.SENSORS_URL, ids, signal);
    }
    /** Read the current state of the given partitions. */
    async getPartitions(ids, signal) {
        return this.#getBatched(settings_1.PARTITIONS_URL, ids, signal);
    }
    /**
     * Send an arming command to a partition.
     *
     * Modifiers are omitted rather than sent as `false` where Alarm.com is known
     * to reject them: `nightArming` and `forceBypass` break the command outright
     * on panels that do not support them, and neither applies to a disarm.
     *
     * Not wrapped in {@link withRetry}: arming is not idempotent from the user's
     * point of view — a duplicate command can produce a second exit-delay
     * countdown. A lapsed session is still recovered once (invalidate + one
     * retry), matching read paths, so dead cookies do not fail a user command
     * that the next poll would have survived.
     */
    async commandPartition(partitionId, action, options = {}) {
        const url = `${settings_1.PARTITIONS_URL}/${encodeURIComponent(partitionId)}/${action}`;
        const isDisarm = action === 'disarm';
        const body = { statePollOnly: false };
        if (!isDisarm) {
            // Always present and always false: the arming endpoint expects both keys,
            // and neither corresponds to anything a HomeKit client can ask for.
            body.noEntryDelay = false;
            body.silentArming = false;
            if (options.nightArming) {
                body.nightArming = true;
            }
            if (options.forceBypass) {
                body.forceBypass = true;
            }
        }
        const tag = nextRequestTag();
        this.#log.debug(`Sending "${action}" to partition ${partitionId} [${tag}]`);
        const attempt = this.#guardedAttempt(url, {
            method: 'POST',
            body,
            tag,
        });
        const response = await this.#withSessionRecovery(attempt, `during command [${tag}]`, isRejectedOutright);
        return response.data;
    }
    /**
     * Obtain a short-lived token for the push event stream.
     *
     * This endpoint answers with a flat object rather than a JSON:API document,
     * unlike every other route on this surface.
     */
    async getEventStreamToken() {
        const response = await this.#request(settings_1.WEBSOCKET_TOKEN_URL);
        if (!response.value) {
            throw new errors_1.ApiParseError('Alarm.com did not return an event stream token');
        }
        // The endpoint is nested under metaData, not alongside the token.
        const endpoint = response.metaData?.endpoint;
        return endpoint
            ? { token: response.value, endpoint }
            : { token: response.value };
    }
    /** Diagnostics for the resilience layers. */
    getStatus() {
        return {
            circuitBreaker: { state: this.#breaker.getStatus().state },
            rateLimiter: { remaining: this.#limiter.getStatus().remaining },
            hasSession: this.#sessionManager.hasSession,
        };
    }
}
exports.AlarmComClient = AlarmComClient;
_a = AlarmComClient;
//# sourceMappingURL=client.js.map