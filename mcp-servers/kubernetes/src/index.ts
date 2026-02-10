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
const appsApi = kc.makeApiClient(k8s.AppsV1Api)

const GetPodsSchema = z.object({
    namespace: z.string().default('default'),
    labelSelector: z.string().optional(),
})

const RestartPodSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
})

const ScaleDeploymentSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
    replicas: z.number().min(0).max(100),
})

const GetEventsSchema = z.object({
    namespace: z.string().default('default'),
    limit: z.number().default(50),
})

async function getPods(namespace: string, labelSelector?: string) {
    const response = await coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
    )
    return response.body.items.map((pod: k8s.V1Pod) => ({
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        status: pod.status?.phase,
        restarts: pod.status?.containerStatuses?.[0]?.restartCount || 0,
        ready: pod.status?.containerStatuses?.every((c: k8s.V1ContainerStatus) => c.ready) || false,
        node: pod.spec?.nodeName,
        createdAt: pod.metadata?.creationTimestamp,
    }))
}

async function restartPod(name: string, namespace: string) {
    await coreApi.deleteNamespacedPod(name, namespace)
    return { success: true, message: `Pod ${name} deleted, will be recreated by controller` }
}

async function scaleDeployment(name: string, namespace: string, replicas: number) {
    const patch = { spec: { replicas } }
    await appsApi.patchNamespacedDeploymentScale(
        name,
        namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    )
    return { success: true, message: `Deployment ${name} scaled to ${replicas} replicas` }
}

async function getEvents(namespace: string, limit: number) {
    const response = await coreApi.listNamespacedEvent(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        limit
    )
    return response.body.items
        .sort((a: k8s.CoreV1Event, b: k8s.CoreV1Event) => {
            const timeA = a.lastTimestamp?.getTime() || 0
            const timeB = b.lastTimestamp?.getTime() || 0
            return timeB - timeA
        })
        .map((event: k8s.CoreV1Event) => ({
            type: event.type,
            reason: event.reason,
            message: event.message,
            involvedObject: event.involvedObject?.name,
            count: event.count,
            lastTimestamp: event.lastTimestamp,
        }))
}

async function getDeployments(namespace: string) {
    const response = await appsApi.listNamespacedDeployment(namespace)
    return response.body.items.map((dep: k8s.V1Deployment) => ({
        name: dep.metadata?.name,
        namespace: dep.metadata?.namespace,
        replicas: dep.spec?.replicas,
        readyReplicas: dep.status?.readyReplicas || 0,
        updatedReplicas: dep.status?.updatedReplicas || 0,
        image: dep.spec?.template?.spec?.containers?.[0]?.image,
    }))
}

async function getNodes() {
    const response = await coreApi.listNode()
    return response.body.items.map((node: k8s.V1Node) => ({
        name: node.metadata?.name,
        status: node.status?.conditions?.find((c: k8s.V1NodeCondition) => c.type === 'Ready')?.status,
        kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
        allocatable: {
            cpu: node.status?.allocatable?.cpu,
            memory: node.status?.allocatable?.memory,
        },
    }))
}

const server = new Server(
    { name: 'kubernetes-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'get_pods',
            description: 'List pods in a namespace with their status and health',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    labelSelector: { type: 'string', description: 'Label selector to filter pods' },
                },
            },
        },
        {
            name: 'restart_pod',
            description: 'Restart a pod by deleting it (controller will recreate)',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Pod name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
                required: ['name'],
            },
        },
        {
            name: 'scale_deployment',
            description: 'Scale a deployment to specified replicas',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Deployment name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    replicas: { type: 'number', description: 'Target replica count' },
                },
                required: ['name', 'replicas'],
            },
        },
        {
            name: 'get_events',
            description: 'Get recent Kubernetes events in a namespace',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    limit: { type: 'number', description: 'Max events to return', default: 50 },
                },
            },
        },
        {
            name: 'get_deployments',
            description: 'List deployments in a namespace',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
            },
        },
        {
            name: 'get_nodes',
            description: 'List cluster nodes with status and resources',
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
            case 'get_pods': {
                const params = GetPodsSchema.parse(args)
                result = await getPods(params.namespace, params.labelSelector)
                break
            }
            case 'restart_pod': {
                const params = RestartPodSchema.parse(args)
                result = await restartPod(params.name, params.namespace)
                break
            }
            case 'scale_deployment': {
                const params = ScaleDeploymentSchema.parse(args)
                result = await scaleDeployment(params.name, params.namespace, params.replicas)
                break
            }
            case 'get_events': {
                const params = GetEventsSchema.parse(args)
                result = await getEvents(params.namespace, params.limit)
                break
            }
            case 'get_deployments': {
                const params = z.object({ namespace: z.string().default('default') }).parse(args)
                result = await getDeployments(params.namespace)
                break
            }
            case 'get_nodes': {
                result = await getNodes()
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
