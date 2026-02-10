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

const appsApi = kc.makeApiClient(k8s.AppsV1Api)

const GetDeploymentsSchema = z.object({
    namespace: z.string().default('default'),
    labelSelector: z.string().optional(),
})

const RollbackSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
    revision: z.number().optional(),
})

const UpdateImageSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
    container: z.string(),
    image: z.string(),
})

const GetRolloutStatusSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
})

const RestartDeploymentSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
})

async function getDeployments(namespace: string, labelSelector?: string) {
    const response = await appsApi.listNamespacedDeployment(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
    )

    return response.body.items.map((dep: k8s.V1Deployment) => ({
        name: dep.metadata?.name,
        namespace: dep.metadata?.namespace,
        replicas: dep.spec?.replicas,
        readyReplicas: dep.status?.readyReplicas || 0,
        updatedReplicas: dep.status?.updatedReplicas || 0,
        availableReplicas: dep.status?.availableReplicas || 0,
        image: dep.spec?.template?.spec?.containers?.[0]?.image,
        strategy: dep.spec?.strategy?.type,
        generation: dep.metadata?.generation,
        observedGeneration: dep.status?.observedGeneration,
        conditions: dep.status?.conditions?.map((c: k8s.V1DeploymentCondition) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
            message: c.message,
        })),
    }))
}

async function getDeploymentHistory(name: string, namespace: string) {
    const response = await appsApi.listNamespacedReplicaSet(namespace)

    const history = response.body.items
        .filter((rs: k8s.V1ReplicaSet) => {
            const ownerRefs = rs.metadata?.ownerReferences || []
            return ownerRefs.some(ref => ref.name === name && ref.kind === 'Deployment')
        })
        .map((rs: k8s.V1ReplicaSet) => ({
            revision: rs.metadata?.annotations?.['deployment.kubernetes.io/revision'],
            name: rs.metadata?.name,
            replicas: rs.spec?.replicas,
            image: rs.spec?.template?.spec?.containers?.[0]?.image,
            createdAt: rs.metadata?.creationTimestamp,
        }))
        .sort((a, b) => {
            const revA = parseInt(a.revision || '0', 10)
            const revB = parseInt(b.revision || '0', 10)
            return revB - revA
        })

    return history
}

async function rollbackDeployment(name: string, namespace: string, revision?: number) {
    const history = await getDeploymentHistory(name, namespace)

    if (history.length < 2) {
        throw new Error('No previous revision available for rollback')
    }

    const targetRevision = revision
        ? history.find(h => h.revision === String(revision))
        : history[1]

    if (!targetRevision) {
        throw new Error(`Revision ${revision} not found`)
    }

    const patch = {
        spec: {
            template: {
                spec: {
                    containers: [{
                        name: name,
                        image: targetRevision.image,
                    }],
                },
            },
        },
    }

    await appsApi.patchNamespacedDeployment(
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

    return {
        success: true,
        message: `Rolled back ${name} to revision ${targetRevision.revision}`,
        image: targetRevision.image,
    }
}

async function updateImage(name: string, namespace: string, container: string, image: string) {
    const deployment = await appsApi.readNamespacedDeployment(name, namespace)

    const containers = deployment.body.spec?.template?.spec?.containers || []
    const targetContainer = containers.find((c: k8s.V1Container) => c.name === container)

    if (!targetContainer) {
        throw new Error(`Container ${container} not found in deployment ${name}`)
    }

    const patch = {
        spec: {
            template: {
                spec: {
                    containers: containers.map((c: k8s.V1Container) =>
                        c.name === container ? { ...c, image } : c
                    ),
                },
            },
        },
    }

    await appsApi.patchNamespacedDeployment(
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

    return {
        success: true,
        message: `Updated ${container} in ${name} to ${image}`,
    }
}

async function getRolloutStatus(name: string, namespace: string) {
    const deployment = await appsApi.readNamespacedDeployment(name, namespace)

    const spec = deployment.body.spec
    const status = deployment.body.status

    const desired = spec?.replicas || 0
    const updated = status?.updatedReplicas || 0
    const ready = status?.readyReplicas || 0
    const available = status?.availableReplicas || 0

    let rolloutStatus = 'unknown'
    if (updated === desired && ready === desired && available === desired) {
        rolloutStatus = 'complete'
    } else if (updated < desired) {
        rolloutStatus = 'progressing'
    } else if (ready < updated) {
        rolloutStatus = 'waiting'
    }

    return {
        name,
        namespace,
        status: rolloutStatus,
        desired,
        updated,
        ready,
        available,
        conditions: status?.conditions?.map((c: k8s.V1DeploymentCondition) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
        })),
    }
}

async function restartDeployment(name: string, namespace: string) {
    const patch = {
        spec: {
            template: {
                metadata: {
                    annotations: {
                        'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
                    },
                },
            },
        },
    }

    await appsApi.patchNamespacedDeployment(
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

    return {
        success: true,
        message: `Deployment ${name} restarted`,
    }
}

const server = new Server(
    { name: 'deployment-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'get_deployments',
            description: 'List deployments with status',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    labelSelector: { type: 'string', description: 'Label selector' },
                },
            },
        },
        {
            name: 'get_deployment_history',
            description: 'Get deployment revision history',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Deployment name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
                required: ['name'],
            },
        },
        {
            name: 'rollback_deployment',
            description: 'Rollback deployment to previous revision',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Deployment name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    revision: { type: 'number', description: 'Target revision (defaults to previous)' },
                },
                required: ['name'],
            },
        },
        {
            name: 'update_image',
            description: 'Update container image in deployment',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Deployment name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    container: { type: 'string', description: 'Container name' },
                    image: { type: 'string', description: 'New image tag' },
                },
                required: ['name', 'container', 'image'],
            },
        },
        {
            name: 'get_rollout_status',
            description: 'Get current rollout status',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Deployment name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
                required: ['name'],
            },
        },
        {
            name: 'restart_deployment',
            description: 'Trigger rolling restart of deployment',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Deployment name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
                required: ['name'],
            },
        },
    ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
        let result: unknown

        switch (name) {
            case 'get_deployments': {
                const params = GetDeploymentsSchema.parse(args)
                result = await getDeployments(params.namespace, params.labelSelector)
                break
            }
            case 'get_deployment_history': {
                const params = z.object({
                    name: z.string(),
                    namespace: z.string().default('default'),
                }).parse(args)
                result = await getDeploymentHistory(params.name, params.namespace)
                break
            }
            case 'rollback_deployment': {
                const params = RollbackSchema.parse(args)
                result = await rollbackDeployment(params.name, params.namespace, params.revision)
                break
            }
            case 'update_image': {
                const params = UpdateImageSchema.parse(args)
                result = await updateImage(params.name, params.namespace, params.container, params.image)
                break
            }
            case 'get_rollout_status': {
                const params = GetRolloutStatusSchema.parse(args)
                result = await getRolloutStatus(params.name, params.namespace)
                break
            }
            case 'restart_deployment': {
                const params = RestartDeploymentSchema.parse(args)
                result = await restartDeployment(params.name, params.namespace)
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
