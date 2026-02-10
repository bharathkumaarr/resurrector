import { eventBus } from './event-bus.js'
import type { FailureType, Severity } from './types.js'

const DEMO_APP_URL = process.env.DEMO_APP_URL || 'http://localhost:8080'
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090'

export interface AnomalyReport {
    detected: boolean
    failureType: FailureType
    severity: Severity
    affectedServices: string[]
    evidence: Record<string, unknown>
    description: string
}

export interface HealthSnapshot {
    demoApp: {
        healthy: boolean
        statusCode: number
        responseTimeMs: number
        error?: string
    }
    database: {
        healthy: boolean
        error?: string
    }
    prometheus: {
        healthy: boolean
        error?: string
    }
    metrics: {
        errorRate: number
        latencyP99Ms: number
        memoryUsageMB: number
        podRestarts: number
        httpRequestsTotal: number
    }
    timestamp: Date
}

async function checkDemoAppHealth(): Promise<HealthSnapshot['demoApp']> {
    const start = Date.now()
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        const response = await fetch(`${DEMO_APP_URL}/health`, {
            signal: controller.signal,
        })
        clearTimeout(timeout)

        const responseTimeMs = Date.now() - start
        const body = await response.json() as Record<string, unknown>

        return {
            healthy: response.ok && body.status === 'healthy',
            statusCode: response.status,
            responseTimeMs,
            error: response.ok ? undefined : `Status ${response.status}: ${JSON.stringify(body)}`,
        }
    } catch (error) {
        return {
            healthy: false,
            statusCode: 0,
            responseTimeMs: Date.now() - start,
            error: error instanceof Error ? error.message : 'Connection failed',
        }
    }
}

async function checkPrometheusHealth(): Promise<{ healthy: boolean; error?: string }> {
    try {
        const response = await fetch(`${PROMETHEUS_URL}/-/healthy`)
        return { healthy: response.ok }
    } catch (error) {
        return { healthy: false, error: error instanceof Error ? error.message : 'Connection failed' }
    }
}

async function queryMetric(query: string): Promise<number> {
    try {
        const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`
        const response = await fetch(url)
        if (!response.ok) return 0

        const data = await response.json() as {
            data: { result: Array<{ value: [number, string] }> }
        }

        if (data.data.result.length > 0) {
            return parseFloat(data.data.result[0].value[1]) || 0
        }
        return 0
    } catch {
        return 0
    }
}

async function getMetrics(): Promise<HealthSnapshot['metrics']> {
    const [errorRate, latency, memory, restarts, requests] = await Promise.all([
        queryMetric('sum(rate(http_requests_total{status=~"5.."}[1m])) / sum(rate(http_requests_total[1m])) * 100'),
        queryMetric('histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[1m])) by (le)) * 1000'),
        queryMetric('process_resident_memory_bytes / 1024 / 1024'),
        queryMetric('sum(increase(http_requests_total{status=~"5.."}[5m]))'),
        queryMetric('sum(http_requests_total)'),
    ])

    return {
        errorRate: isNaN(errorRate) ? 0 : errorRate,
        latencyP99Ms: isNaN(latency) ? 0 : latency,
        memoryUsageMB: isNaN(memory) ? 0 : memory,
        podRestarts: isNaN(restarts) ? 0 : Math.round(restarts),
        httpRequestsTotal: isNaN(requests) ? 0 : Math.round(requests),
    }
}

export async function getHealthSnapshot(): Promise<HealthSnapshot> {
    const [demoApp, prometheus, metrics] = await Promise.all([
        checkDemoAppHealth(),
        checkPrometheusHealth(),
        getMetrics(),
    ])

    const snapshot: HealthSnapshot = {
        demoApp,
        database: {
            healthy: demoApp.healthy,
            error: demoApp.healthy ? undefined : 'Inferred from app health',
        },
        prometheus,
        metrics,
        timestamp: new Date(),
    }

    const status = demoApp.healthy ? 'health:healthy' : 'health:degraded'
    eventBus.emit(status, {
        demoApp: demoApp.healthy,
        prometheus: prometheus.healthy,
        responseTimeMs: demoApp.responseTimeMs,
        errorRate: metrics.errorRate,
    })

    return snapshot
}

export function detectAnomalies(snapshot: HealthSnapshot): AnomalyReport | null {
    // Service completely down
    if (!snapshot.demoApp.healthy && snapshot.demoApp.statusCode === 0) {
        return {
            detected: true,
            failureType: 'service_down',
            severity: 'critical',
            affectedServices: ['demo-app'],
            evidence: {
                statusCode: snapshot.demoApp.statusCode,
                error: snapshot.demoApp.error,
                responseTimeMs: snapshot.demoApp.responseTimeMs,
            },
            description: 'Demo application is completely unreachable. Service appears to be down.',
        }
    }

    // Service unhealthy (503)
    if (!snapshot.demoApp.healthy && snapshot.demoApp.statusCode === 503) {
        return {
            detected: true,
            failureType: 'service_down',
            severity: 'high',
            affectedServices: ['demo-app'],
            evidence: {
                statusCode: snapshot.demoApp.statusCode,
                error: snapshot.demoApp.error,
                responseTimeMs: snapshot.demoApp.responseTimeMs,
            },
            description: 'Demo application health check returning 503 Unhealthy.',
        }
    }

    // Latency spike (response time > 2000ms)
    if (snapshot.demoApp.responseTimeMs > 2000) {
        return {
            detected: true,
            failureType: 'latency_spike',
            severity: 'high',
            affectedServices: ['demo-app'],
            evidence: {
                responseTimeMs: snapshot.demoApp.responseTimeMs,
                latencyP99Ms: snapshot.metrics.latencyP99Ms,
            },
            description: `High latency detected: ${snapshot.demoApp.responseTimeMs}ms response time.`,
        }
    }

    // High error rate (>5%)
    if (snapshot.metrics.errorRate > 5) {
        return {
            detected: true,
            failureType: 'dependency_failure',
            severity: 'high',
            affectedServices: ['demo-app'],
            evidence: {
                errorRate: snapshot.metrics.errorRate,
            },
            description: `High error rate detected: ${snapshot.metrics.errorRate.toFixed(1)}% of requests failing.`,
        }
    }

    // Memory pressure (>200MB for the demo app)
    if (snapshot.metrics.memoryUsageMB > 200) {
        return {
            detected: true,
            failureType: 'memory_leak',
            severity: 'medium',
            affectedServices: ['demo-app'],
            evidence: {
                memoryUsageMB: snapshot.metrics.memoryUsageMB,
            },
            description: `Memory pressure detected: ${snapshot.metrics.memoryUsageMB.toFixed(0)}MB used.`,
        }
    }

    return null
}
