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

const GetConfigMapSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
})

const ListConfigMapsSchema = z.object({
    namespace: z.string().default('default'),
    labelSelector: z.string().optional(),
})

const UpdateConfigMapSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
    data: z.record(z.string()),
    merge: z.boolean().default(true),
})

const CreateConfigMapSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
    data: z.record(z.string()),
})

const ValidateConfigSchema = z.object({
    name: z.string(),
    namespace: z.string().default('default'),
    requiredKeys: z.array(z.string()).optional(),
})

async function getConfigMap(name: string, namespace: string) {
    const response = await coreApi.readNamespacedConfigMap(name, namespace)
    return {
        name: response.body.metadata?.name,
        namespace: response.body.metadata?.namespace,
        data: response.body.data,
        createdAt: response.body.metadata?.creationTimestamp,
        resourceVersion: response.body.metadata?.resourceVersion,
    }
}

async function listConfigMaps(namespace: string, labelSelector?: string) {
    const response = await coreApi.listNamespacedConfigMap(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
    )
    return response.body.items.map((cm: k8s.V1ConfigMap) => ({
        name: cm.metadata?.name,
        namespace: cm.metadata?.namespace,
        keys: Object.keys(cm.data || {}),
        createdAt: cm.metadata?.creationTimestamp,
    }))
}

async function updateConfigMap(
    name: string,
    namespace: string,
    data: Record<string, string>,
    merge: boolean
) {
    const existing = await coreApi.readNamespacedConfigMap(name, namespace)

    const newData = merge
        ? { ...existing.body.data, ...data }
        : data

    const patch = { data: newData }

    await coreApi.patchNamespacedConfigMap(
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
        message: `ConfigMap ${name} updated`,
        data: newData,
    }
}

async function createConfigMap(
    name: string,
    namespace: string,
    data: Record<string, string>
) {
    const configMap: k8s.V1ConfigMap = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name, namespace },
        data,
    }

    await coreApi.createNamespacedConfigMap(namespace, configMap)

    return {
        success: true,
        message: `ConfigMap ${name} created`,
    }
}

async function deleteConfigMap(name: string, namespace: string) {
    await coreApi.deleteNamespacedConfigMap(name, namespace)
    return { success: true, message: `ConfigMap ${name} deleted` }
}

async function validateConfig(
    name: string,
    namespace: string,
    requiredKeys?: string[]
) {
    try {
        const cm = await getConfigMap(name, namespace)
        const data = cm.data || {}
        const existingKeys = Object.keys(data)

        const issues: string[] = []

        if (requiredKeys) {
            for (const key of requiredKeys) {
                if (!existingKeys.includes(key)) {
                    issues.push(`Missing required key: ${key}`)
                }
            }
        }

        for (const [key, value] of Object.entries(data)) {
            if (!value || value.trim() === '') {
                issues.push(`Empty value for key: ${key}`)
            }
        }

        return {
            valid: issues.length === 0,
            name,
            namespace,
            keys: existingKeys,
            issues,
        }
    } catch (error) {
        return {
            valid: false,
            name,
            namespace,
            keys: [],
            issues: [`ConfigMap not found: ${error instanceof Error ? error.message : 'unknown error'}`],
        }
    }
}

async function getSecretKeys(name: string, namespace: string) {
    const response = await coreApi.readNamespacedSecret(name, namespace)
    return {
        name: response.body.metadata?.name,
        namespace: response.body.metadata?.namespace,
        keys: Object.keys(response.body.data || {}),
        type: response.body.type,
        createdAt: response.body.metadata?.creationTimestamp,
    }
}

async function listSecrets(namespace: string, labelSelector?: string) {
    const response = await coreApi.listNamespacedSecret(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
    )
    return response.body.items.map((secret: k8s.V1Secret) => ({
        name: secret.metadata?.name,
        namespace: secret.metadata?.namespace,
        type: secret.type,
        keys: Object.keys(secret.data || {}),
    }))
}

const server = new Server(
    { name: 'config-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'get_configmap',
            description: 'Get a ConfigMap with its data',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'ConfigMap name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
                required: ['name'],
            },
        },
        {
            name: 'list_configmaps',
            description: 'List ConfigMaps in a namespace',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    labelSelector: { type: 'string', description: 'Label selector' },
                },
            },
        },
        {
            name: 'update_configmap',
            description: 'Update a ConfigMap',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'ConfigMap name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    data: { type: 'object', description: 'Key-value pairs to set' },
                    merge: { type: 'boolean', description: 'Merge with existing data', default: true },
                },
                required: ['name', 'data'],
            },
        },
        {
            name: 'create_configmap',
            description: 'Create a new ConfigMap',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'ConfigMap name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    data: { type: 'object', description: 'Key-value pairs' },
                },
                required: ['name', 'data'],
            },
        },
        {
            name: 'delete_configmap',
            description: 'Delete a ConfigMap',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'ConfigMap name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
                required: ['name'],
            },
        },
        {
            name: 'validate_config',
            description: 'Validate a ConfigMap for required keys and empty values',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'ConfigMap name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    requiredKeys: { type: 'array', items: { type: 'string' }, description: 'Required keys' },
                },
                required: ['name'],
            },
        },
        {
            name: 'get_secret_keys',
            description: 'Get Secret metadata (keys only, not values)',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Secret name' },
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                },
                required: ['name'],
            },
        },
        {
            name: 'list_secrets',
            description: 'List Secrets in a namespace (metadata only)',
            inputSchema: {
                type: 'object',
                properties: {
                    namespace: { type: 'string', description: 'Kubernetes namespace', default: 'default' },
                    labelSelector: { type: 'string', description: 'Label selector' },
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
            case 'get_configmap': {
                const params = GetConfigMapSchema.parse(args)
                result = await getConfigMap(params.name, params.namespace)
                break
            }
            case 'list_configmaps': {
                const params = ListConfigMapsSchema.parse(args)
                result = await listConfigMaps(params.namespace, params.labelSelector)
                break
            }
            case 'update_configmap': {
                const params = UpdateConfigMapSchema.parse(args)
                result = await updateConfigMap(params.name, params.namespace, params.data, params.merge)
                break
            }
            case 'create_configmap': {
                const params = CreateConfigMapSchema.parse(args)
                result = await createConfigMap(params.name, params.namespace, params.data)
                break
            }
            case 'delete_configmap': {
                const params = z.object({
                    name: z.string(),
                    namespace: z.string().default('default'),
                }).parse(args)
                result = await deleteConfigMap(params.name, params.namespace)
                break
            }
            case 'validate_config': {
                const params = ValidateConfigSchema.parse(args)
                result = await validateConfig(params.name, params.namespace, params.requiredKeys)
                break
            }
            case 'get_secret_keys': {
                const params = GetConfigMapSchema.parse(args)
                result = await getSecretKeys(params.name, params.namespace)
                break
            }
            case 'list_secrets': {
                const params = ListConfigMapsSchema.parse(args)
                result = await listSecrets(params.namespace, params.labelSelector)
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
