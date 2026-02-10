import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090'

const QuerySchema = z.object({
    query: z.string(),
    time: z.string().optional(),
})

const RangeQuerySchema = z.object({
    query: z.string(),
    start: z.string(),
    end: z.string(),
    step: z.string().default('15s'),
})

const ResourceUsageSchema = z.object({
    namespace: z.string().default('default'),
    pod: z.string().optional(),
})

interface PrometheusResult {
    metric: Record<string, string>
    value?: [number, string]
    values?: Array<[number, string]>
}

interface PrometheusResponse {
    status: string
    data: {
        resultType: string
        result: PrometheusResult[]
    }
}

interface AlertsResponse {
    status: string
    data: {
        alerts: Array<Record<string, unknown>>
    }
}

async function queryPrometheus(query: string, time?: string): Promise<PrometheusResponse> {
    const url = new URL(`${PROMETHEUS_URL}/api/v1/query`)
    url.searchParams.set('query', query)
    if (time) url.searchParams.set('time', time)

    const response = await fetch(url.toString())
    if (!response.ok) {
        throw new Error(`Prometheus query failed: ${response.statusText}`)
    }
    return response.json() as Promise<PrometheusResponse>
}

async function queryPrometheusRange(
    query: string,
    start: string,
    end: string,
    step: string
): Promise<PrometheusResponse> {
    const url = new URL(`${PROMETHEUS_URL}/api/v1/query_range`)
    url.searchParams.set('query', query)
    url.searchParams.set('start', start)
    url.searchParams.set('end', end)
    url.searchParams.set('step', step)

    const response = await fetch(url.toString())
    if (!response.ok) {
        throw new Error(`Prometheus range query failed: ${response.statusText}`)
    }
    return response.json() as Promise<PrometheusResponse>
}

async function getCpuUsage(namespace: string, pod?: string) {
    const query = `sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}"${pod ? `,pod="${pod}"` : ''}}[5m])) by (pod)`
    const result = await queryPrometheus(query)
    return result.data.result.map(r => ({
        pod: r.metric.pod,
        cpuCores: parseFloat(r.value?.[1] || '0'),
    }))
}

async function getMemoryUsage(namespace: string, pod?: string) {
    const query = `sum(container_memory_working_set_bytes{namespace="${namespace}"${pod ? `,pod="${pod}"` : ''}} / 1024 / 1024) by (pod)`
    const result = await queryPrometheus(query)
    return result.data.result.map(r => ({
        pod: r.metric.pod,
        memoryMB: parseFloat(r.value?.[1] || '0'),
    }))
}

async function getErrorRate(namespace: string) {
    const query = `sum(rate(http_requests_total{namespace="${namespace}",status=~"5.."}[5m])) by (service) / sum(rate(http_requests_total{namespace="${namespace}"}[5m])) by (service) * 100`
    const result = await queryPrometheus(query)
    return result.data.result.map(r => ({
        service: r.metric.service,
        errorRatePercent: parseFloat(r.value?.[1] || '0'),
    }))
}

async function getLatencyP99(namespace: string) {
    const query = `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{namespace="${namespace}"}[5m])) by (le, service))`
    const result = await queryPrometheus(query)
    return result.data.result.map(r => ({
        service: r.metric.service,
        latencyP99Seconds: parseFloat(r.value?.[1] || '0'),
    }))
}

async function getPodRestarts(namespace: string) {
    const query = `sum(kube_pod_container_status_restarts_total{namespace="${namespace}"}) by (pod)`
    const result = await queryPrometheus(query)
    return result.data.result
        .map(r => ({
            pod: r.metric.pod,
            restarts: parseInt(r.value?.[1] || '0', 10),
        }))
        .filter(r => r.restarts > 0)
        .sort((a, b) => b.restarts - a.restarts)
}

async function getResourceUsage(namespace: string, pod?: string) {
    const [cpu, memory] = await Promise.all([
        getCpuUsage(namespace, pod),
        getMemoryUsage(namespace, pod),
    ])

    const combined = new Map<string, { pod: string; cpuCores: number; memoryMB: number }>()

    for (const c of cpu) {
        combined.set(c.pod, { pod: c.pod, cpuCores: c.cpuCores, memoryMB: 0 })
    }
    for (const m of memory) {
        const existing = combined.get(m.pod)
        if (existing) {
            existing.memoryMB = m.memoryMB
        } else {
            combined.set(m.pod, { pod: m.pod, cpuCores: 0, memoryMB: m.memoryMB })
        }
    }

    return Array.from(combined.values())
}

async function getAlerts() {
    const url = `${PROMETHEUS_URL}/api/v1/alerts`
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to get alerts: ${response.statusText}`)
    }
    const data = await response.json() as AlertsResponse
    return data.data.alerts
}

const server = new Server(
    { name: 'metrics-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'query_prometheus',
            description: 'Execute an instant Prometheus query',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'PromQL query' },
                    time: { type: 'string', description: 'Evaluation timestamp (RFC3339 or Unix)' },
                },
                required: ['query'],
            },
        },
        {
            name: 'query_prometheus_range',
            description: 'Execute a range query over time',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'PromQL query' },
                    start: { type: 'string', description: 'Start time (RFC3339 or Unix)' },
                    end: { type: 'string', description: 'End time (RFC3339 or Unix)' },
                    step: { type: 'string', description: 'Query resolution step', default: '15s' },
                },
                required: ['query', 'start', 'end'],
            },
        },
        {
            name: 'get_resource_usage',
            description: 'Get CPU and memory usage for pods',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    pod: { type: 'string', description: 'Specific pod name (optional)' },
                },
            },
        },
        {
            name: 'get_error_rate',
            description: 'Get HTTP error rates by service',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
            },
        },
        {
            name: 'get_latency',
            description: 'Get P99 latency by service',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
            },
        },
        {
            name: 'get_pod_restarts',
            description: 'Get pods with restart counts',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
            },
        },
        {
            name: 'get_alerts',
            description: 'Get active Prometheus alerts',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
    ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
        let result: unknown

        switch (name) {
            case 'query_prometheus': {
                const params = QuerySchema.parse(args)
                result = await queryPrometheus(params.query, params.time)
                break
            }
            case 'query_prometheus_range': {
                const params = RangeQuerySchema.parse(args)
                result = await queryPrometheusRange(params.query, params.start, params.end, params.step)
                break
            }
            case 'get_resource_usage': {
                const params = ResourceUsageSchema.parse(args)
                result = await getResourceUsage(params.namespace, params.pod)
                break
            }
            case 'get_error_rate': {
                const params = z.object({ namespace: z.string().default('default') }).parse(args)
                result = await getErrorRate(params.namespace)
                break
            }
            case 'get_latency': {
                const params = z.object({ namespace: z.string().default('default') }).parse(args)
                result = await getLatencyP99(params.namespace)
                break
            }
            case 'get_pod_restarts': {
                const params = z.object({ namespace: z.string().default('default') }).parse(args)
                result = await getPodRestarts(params.namespace)
                break
            }
            case 'get_alerts': {
                result = await getAlerts()
                break
            }
            default:
                throw new Error(`Unknown tool: ${name}`)
        }

        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
        }
    }
})

async function main() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
}

main().catch(console.error)
