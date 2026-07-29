"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Typed client for the Alarm.com JSON:API surface.
 *
 * Every outbound call passes through pacing, then the circuit breaker, then
 * retry. That order is deliberate: pacing shapes normal traffic, the breaker
 * stops a failing service being hammered, and retry only ever runs inside those
 * two guards so it cannot amplify a problem.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlarmComClient = void 0;
exports.chunkIds = chunkIds;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const retry_1 = require("../utils/retry");
const sanitizers_1 = require("../utils/sanitizers");
const circuit_breaker_1 = require("./circuit-breaker");
const http_1 = require("./http");
const rate_limiter_1 = require("./rate-limiter");
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
/** Extract the linkage list from a JSON:API relationship. */
function readRelationshipIds(resource, name) {
    const data = resource?.relationships?.[name]?.data;
    if (!Array.isArray(data)) {
        return data ? [data.id] : [];
    }
    return data.map((entry) => entry.id);
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
    constructor(options) {
        this.#sessionManager = options.sessionManager;
        this.#log = options.log;
        this.#metrics = options.metrics;
        this.#onThrottle = options.onThrottle;
        this.#onRetry = options.onRetry;
        this.#breaker = options.circuitBreaker ?? new circuit_breaker_1.CircuitBreaker();
        this.#breaker.attachOnStateChange((from, to) => {
            this.#logCircuitTransition(from, to);
            if (to === circuit_breaker_1.CircuitState.OPEN && from !== circuit_breaker_1.CircuitState.OPEN) {
                options.onCircuitOpen?.();
            }
        });
        this.#limiter = options.rateLimiter ?? new rate_limiter_1.RateLimiter();
    }
    /**
     * Surface circuit-breaker transitions so operators can see when Alarm.com is
     * being treated as unavailable and when it recovers.
     */
    #logCircuitTransition(from, to) {
        const message = `Circuit breaker ${from} -> ${to}`;
        if (to === circuit_breaker_1.CircuitState.OPEN) {
            this.#log.warn(message);
        }
        else {
            this.#log.info(message);
        }
    }
    /** Issue one authenticated request and parse the JSON:API response. */
    async #send(url, options = {}) {
        const session = await this.#sessionManager.getSession();
        const { method = 'GET', body } = options;
        const headers = {
            Accept: settings_1.JSON_API_ACCEPT,
            Cookie: session.cookieHeader,
            ajaxrequestuniquekey: session.ajaxKey,
            Referer: settings_1.HOME_REFERER,
        };
        if (body !== undefined) {
            headers['Content-Type'] = settings_1.JSON_API_ACCEPT;
        }
        const response = await (0, http_1.httpRequest)(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok) {
            throw (0, errors_1.createApiError)(response.status, `Alarm.com returned ${response.status} for ${(0, sanitizers_1.sanitizeUrl)(url)}`, { body: text });
        }
        try {
            return JSON.parse(text);
        }
        catch (error) {
            // Alarm.com serves an HTML login page rather than a JSON error when a
            // session lapses, so an unparseable body usually means "sign in again".
            throw new errors_1.ApiParseError(`Alarm.com returned a non-JSON response for ${(0, sanitizers_1.sanitizeUrl)(url)}; the session may have expired`, error instanceof Error ? { cause: error } : undefined);
        }
    }
    /**
     * Send a request under pacing, the circuit breaker, and retry.
     *
     * A lapsed session is retried exactly once with a fresh login. Beyond that it
     * propagates, because repeatedly re-authenticating against a service that
     * keeps rejecting us is how accounts get locked.
     */
    async #request(url, options = {}) {
        const attempt = () => this.#timedAttempt(() => this.#limiter.execute(() => this.#breaker.execute(() => this.#send(url, options))));
        return (0, retry_1.withRetry)(async () => {
            try {
                return await attempt();
            }
            catch (error) {
                // A lapsed session announces itself two ways: a 401, and an HTTP 200
                // carrying the HTML login page, which fails to parse. Treating only
                // the 401 as expiry meant the HTML case kept reusing dead cookies
                // until the auth interval elapsed, turning a one-request recovery
                // into minutes of failing polls.
                if (error instanceof errors_1.SessionExpiredError || error instanceof errors_1.ApiParseError) {
                    this.#log.debug('session rejected; re-authenticating once before giving up');
                    this.#sessionManager.invalidate();
                    return attempt();
                }
                throw error;
            }
        }, {
            onRetry: (attemptNumber, delayMs, error) => {
                this.#onRetry?.();
                this.#log.debug(`retrying ${(0, sanitizers_1.sanitizeUrl)(url)} (attempt ${attemptNumber}) in ${delayMs}ms after ${String(error)}`);
            },
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
            this.#metrics?.({ durationMs: Date.now() - started, ok: true, networked: true });
            return result;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isThrottle = message.includes('Request pacing would require waiting');
            const isBreaker = error instanceof errors_1.CircuitBreakerError;
            const networked = !isThrottle && !isBreaker;
            if (isThrottle) {
                this.#onThrottle?.();
            }
            this.#metrics?.({ durationMs: Date.now() - started, ok: false, networked });
            throw error;
        }
    }
    /** Resolve the system this account has selected. */
    async getSystemId() {
        const response = await this.#request(settings_1.IDENTITIES_URL);
        const identity = response.data?.[0];
        const selected = identity?.relationships?.selectedSystem?.data;
        if (!selected || Array.isArray(selected)) {
            throw new errors_1.ApiParseError('Alarm.com did not report a selected system for this account');
        }
        return selected.id;
    }
    /** List the partition and sensor IDs belonging to a system. */
    async getSystemDevices(systemId) {
        const url = `${settings_1.SYSTEM_URL}${encodeURIComponent(systemId)}`;
        const response = await this.#request(url);
        return {
            partitionIds: readRelationshipIds(response.data, 'partitions'),
            sensorIds: readRelationshipIds(response.data, 'sensors'),
        };
    }
    /** Fetch a collection in batches the API will accept. */
    async #getBatched(baseUrl, ids) {
        if (ids.length === 0) {
            return [];
        }
        const results = [];
        // Sequential, not parallel: concurrent bursts are what the pacing exists to
        // prevent, and discovery is not latency-sensitive.
        for (const chunk of chunkIds(ids)) {
            const response = await this.#request(buildBatchUrl(baseUrl, chunk));
            results.push(...(response.data ?? []));
        }
        return results;
    }
    async getSensors(ids) {
        return this.#getBatched(settings_1.SENSORS_URL, ids);
    }
    async getPartitions(ids) {
        return this.#getBatched(settings_1.PARTITIONS_URL, ids);
    }
    /**
     * Send an arming command to a partition.
     *
     * Modifiers are omitted rather than sent as `false` where Alarm.com is known
     * to reject them: `nightArming` and `forceBypass` break the command outright
     * on panels that do not support them, and neither applies to a disarm.
     *
     * Not wrapped in retry. Arming is not idempotent from the user's point of
     * view — a duplicate command can produce a second exit-delay countdown — so a
     * failure is reported rather than silently repeated.
     */
    async commandPartition(partitionId, action, options = {}) {
        const url = `${settings_1.PARTITIONS_URL}/${encodeURIComponent(partitionId)}/${action}`;
        const isDisarm = action === 'disarm';
        const body = { statePollOnly: false };
        if (!isDisarm) {
            body.noEntryDelay = Boolean(options.noEntryDelay);
            body.silentArming = Boolean(options.silentArming);
            if (options.nightArming) {
                body.nightArming = true;
            }
            if (options.forceBypass) {
                body.forceBypass = true;
            }
        }
        this.#log.debug(`Sending "${action}" to partition ${partitionId}`);
        const response = await this.#limiter.execute(() => this.#breaker.execute(() => this.#send(url, { method: 'POST', body })));
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
//# sourceMappingURL=client.js.map