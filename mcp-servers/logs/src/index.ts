import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as k8s from '@kubernetes/client-node'
import { z } from 'zod'

const kc = new k8s.KubeConfig()
kc.loadFromDefault()

const coreApi = kc.makeApiClient(k8s.CoreV1Api)

const GetLogsSchema = z.object({
    pod: z.string(),
    namespace: z.string().default('default'),
    container: z.string().optional(),
    tailLines: z.number().default(100),
    sinceSeconds: z.number().optional(),
})

const SearchLogsSchema = z.object({
    pod: z.string(),
    namespace: z.string().default('default'),
    container: z.string().optional(),
    pattern: z.string(),
    tailLines: z.number().default(500),
})

const GetPodLogsMultipleSchema = z.object({
    namespace: z.string().default('default'),
    labelSelector: z.string(),
    tailLines: z.number().default(50),
})

interface LogEntry {
    timestamp: string
    message: string
    level?: string
}

function parseLogLine(line: string): LogEntry {
    const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*)/)
    const levelMatch = line.match(/\b(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\b/i)

    return {
        timestamp: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
        message: line,
        level: levelMatch ? levelMatch[1].toUpperCase() : undefined,
    }
}

async function getPodLogs(
    pod: string,
    namespace: string,
    container?: string,
    tailLines = 100,
    sinceSeconds?: number
) {
    const response = await coreApi.readNamespacedPodLog(
        pod,
        namespace,
        container,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sinceSeconds,
        tailLines
    )

    const logText = response.body || ''
    const lines = logText.split('\n').filter(Boolean)
    return lines.map(parseLogLine)
}

async function searchLogs(
    pod: string,
    namespace: string,
    pattern: string,
    container?: string,
    tailLines = 500
) {
    const response = await coreApi.readNamespacedPodLog(
        pod,
        namespace,
        container,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tailLines
    )

    const logText = response.body || ''
    const regex = new RegExp(pattern, 'i')
    const lines = logText.split('\n').filter(Boolean)
    const matches = lines.filter((line: string) => regex.test(line))

    return {
        totalLines: lines.length,
        matchCount: matches.length,
        matches: matches.map(parseLogLine),
    }
}

async function getLogsForSelector(
    namespace: string,
    labelSelector: string,
    tailLines: number
) {
    const pods = await coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
    )

    const results: Array<{ pod: string; logs: LogEntry[] }> = []

    for (const pod of pods.body.items) {
        const name = pod.metadata?.name
        if (!name) continue

        try {
            const logs = await getPodLogs(name, namespace, undefined, tailLines)
            results.push({ pod: name, logs })
        } catch {
            results.push({ pod: name, logs: [] })
        }
    }

    return results
}

async function getErrorLogs(namespace: string, tailLines: number) {
    const pods = await coreApi.listNamespacedPod(namespace)
    const errors: Array<{ pod: string; errors: LogEntry[] }> = []

    for (const pod of pods.body.items) {
        const name = pod.metadata?.name
        if (!name) continue

        try {
            const result = await searchLogs(name, namespace, 'error|exception|fatal', undefined, tailLines)
            if (result.matches.length > 0) {
                errors.push({ pod: name, errors: result.matches })
            }
        } catch {
            continue
        }
    }

    return errors
}

const server = new Server(
    { name: 'logs-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'get_logs',
            description: 'Get logs from a specific pod',
            inputSchema: {
                type: 'object',
                properties: {
                    pod: { type: 'string', description: 'Pod name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    container: { type: 'string', description: 'Container name (optional)' },
                    tailLines: { type: 'number', description: 'Number of lines to return', default: 100 },
                    sinceSeconds: { type: 'number', description: 'Return logs from last N seconds' },
                },
                required: ['pod'],
            },
        },
        {
            name: 'search_logs',
            description: 'Search logs for a pattern in a pod',
            inputSchema: {
                type: 'object',
                properties: {
                    pod: { type: 'string', description: 'Pod name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    container: { type: 'string', description: 'Container name (optional)' },
                    pattern: { type: 'string', description: 'Search pattern (regex supported)' },
                    tailLines: { type: 'number', description: 'Number of lines to search', default: 500 },
                },
                required: ['pod', 'pattern'],
            },
        },
        {
            name: 'get_logs_by_selector',
            description: 'Get logs from pods matching a label selector',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    labelSelector: { type: 'string', description: 'Label selector (e.g., app=myapp)' },
                    tailLines: { type: 'number', description: 'Lines per pod', default: 50 },
                },
                required: ['labelSelector'],
            },
        },
        {
            name: 'get_error_logs',
            description: 'Get error logs from all pods in a namespace',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    tailLines: { type: 'number', description: 'Lines to scan per pod', default: 200 },
                },
            },
        },
    ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
        let result: unknown

        switch (name) {
            case 'get_logs': {
                const params = GetLogsSchema.parse(args)
                result = await getPodLogs(
                    params.pod,
                    params.namespace,
                    params.container,
                    params.tailLines,
                    params.sinceSeconds
                )
                break
            }
            case 'search_logs': {
                const params = SearchLogsSchema.parse(args)
                result = await searchLogs(
                    params.pod,
                    params.namespace,
                    params.pattern,
                    params.container,
                    params.tailLines
                )
                break
            }
            case 'get_logs_by_selector': {
                const params = GetPodLogsMultipleSchema.parse(args)
                result = await getLogsForSelector(
                    params.namespace,
                    params.labelSelector,
                    params.tailLines
                )
                break
            }
            case 'get_error_logs': {
                const params = z.object({
                    namespace: z.string().default('default'),
                    tailLines: z.number().default(200),
                }).parse(args)
                result = await getErrorLogs(params.namespace, params.tailLines)
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
