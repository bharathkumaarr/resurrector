import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'

const execAsync = promisify(exec)

const DB_HOST = process.env.DB_HOST || 'localhost'
const DB_PORT = process.env.DB_PORT || '5432'
const DB_USER = process.env.DB_USER || 'postgres'
const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres'
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups'

interface Snapshot {
    id: string
    name: string
    database: string
    createdAt: string
    size: number
    status: 'available' | 'creating' | 'restoring' | 'failed'
}

const snapshots = new Map<string, Snapshot>()

const CreateSnapshotSchema = z.object({
    database: z.string(),
    name: z.string().optional(),
})

const RestoreSnapshotSchema = z.object({
    snapshotId: z.string(),
    targetDatabase: z.string().optional(),
})

const ListSnapshotsSchema = z.object({
    database: z.string().optional(),
})

function generateId(): string {
    return `snap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

async function createSnapshot(database: string, name?: string): Promise<Snapshot> {
    const id = generateId()
    const snapshotName = name || `${database}-${new Date().toISOString().split('T')[0]}`
    const filename = `${id}.sql`
    const filepath = path.join(BACKUP_DIR, filename)

    const snapshot: Snapshot = {
        id,
        name: snapshotName,
        database,
        createdAt: new Date().toISOString(),
        size: 0,
        status: 'creating',
    }
    snapshots.set(id, snapshot)

    try {
        await fs.mkdir(BACKUP_DIR, { recursive: true })

        const command = `PGPASSWORD=${DB_PASSWORD} pg_dump -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${database} -f ${filepath}`
        await execAsync(command)

        const stats = await fs.stat(filepath)
        snapshot.size = stats.size
        snapshot.status = 'available'
    } catch (error) {
        snapshot.status = 'failed'
        throw error
    }

    return snapshot
}

async function restoreSnapshot(snapshotId: string, targetDatabase?: string): Promise<{ success: boolean; message: string }> {
    const snapshot = snapshots.get(snapshotId)
    if (!snapshot) {
        throw new Error(`Snapshot ${snapshotId} not found`)
    }

    const filepath = path.join(BACKUP_DIR, `${snapshotId}.sql`)
    const database = targetDatabase || snapshot.database

    snapshot.status = 'restoring'

    try {
        const dropCommand = `PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -c "DROP DATABASE IF EXISTS ${database}"`
        await execAsync(dropCommand)

        const createCommand = `PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -c "CREATE DATABASE ${database}"`
        await execAsync(createCommand)

        const restoreCommand = `PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${database} -f ${filepath}`
        await execAsync(restoreCommand)

        snapshot.status = 'available'
        return { success: true, message: `Database ${database} restored from snapshot ${snapshotId}` }
    } catch (error) {
        snapshot.status = 'failed'
        throw error
    }
}

async function listSnapshots(database?: string): Promise<Snapshot[]> {
    const all = Array.from(snapshots.values())
    if (database) {
        return all.filter(s => s.database === database)
    }
    return all
}

async function deleteSnapshot(snapshotId: string): Promise<{ success: boolean }> {
    const snapshot = snapshots.get(snapshotId)
    if (!snapshot) {
        throw new Error(`Snapshot ${snapshotId} not found`)
    }

    const filepath = path.join(BACKUP_DIR, `${snapshotId}.sql`)
    try {
        await fs.unlink(filepath)
    } catch {
        // File might not exist
    }

    snapshots.delete(snapshotId)
    return { success: true }
}

async function verifySnapshot(snapshotId: string): Promise<{ valid: boolean; details: string }> {
    const snapshot = snapshots.get(snapshotId)
    if (!snapshot) {
        throw new Error(`Snapshot ${snapshotId} not found`)
    }

    const filepath = path.join(BACKUP_DIR, `${snapshotId}.sql`)

    try {
        const stats = await fs.stat(filepath)
        if (stats.size === 0) {
            return { valid: false, details: 'Snapshot file is empty' }
        }

        const content = await fs.readFile(filepath, 'utf-8')
        const hasCreateStatements = content.includes('CREATE TABLE') || content.includes('CREATE INDEX')

        return {
            valid: hasCreateStatements,
            details: hasCreateStatements
                ? `Valid snapshot, ${stats.size} bytes`
                : 'Snapshot may be incomplete',
        }
    } catch {
        return { valid: false, details: 'Snapshot file not found' }
    }
}

async function checkDatabaseHealth(database: string): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
    try {
        const command = `PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${database} -c "SELECT 1"`
        await execAsync(command)

        const sizeCommand = `PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${database} -t -c "SELECT pg_database_size('${database}')"`
        const { stdout: sizeOutput } = await execAsync(sizeCommand)
        const size = parseInt(sizeOutput.trim(), 10)

        const connectionsCommand = `PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${database} -t -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '${database}'"`
        const { stdout: connOutput } = await execAsync(connectionsCommand)
        const connections = parseInt(connOutput.trim(), 10)

        return {
            healthy: true,
            details: {
                database,
                sizeBytes: size,
                activeConnections: connections,
            },
        }
    } catch (error) {
        return {
            healthy: false,
            details: {
                database,
                error: error instanceof Error ? error.message : 'Unknown error',
            },
        }
    }
}

const server = new Server(
    { name: 'database-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'create_snapshot',
            description: 'Create a database backup snapshot',
            inputSchema: {
                type: 'object',
                properties: {
                    database: { type: 'string', description: 'Database name to backup' },
                    name: { type: 'string', description: 'Optional snapshot name' },
                },
                required: ['database'],
            },
        },
        {
            name: 'restore_snapshot',
            description: 'Restore a database from a snapshot',
            inputSchema: {
                type: 'object',
                properties: {
                    snapshotId: { type: 'string', description: 'Snapshot ID to restore' },
                    targetDatabase: { type: 'string', description: 'Target database name (defaults to original)' },
                },
                required: ['snapshotId'],
            },
        },
        {
            name: 'list_snapshots',
            description: 'List available database snapshots',
            inputSchema: {
                type: 'object',
                properties: {
                    database: { type: 'string', description: 'Filter by database name' },
                },
            },
        },
        {
            name: 'delete_snapshot',
            description: 'Delete a database snapshot',
            inputSchema: {
                type: 'object',
                properties: {
                    snapshotId: { type: 'string', description: 'Snapshot ID to delete' },
                },
                required: ['snapshotId'],
            },
        },
        {
            name: 'verify_snapshot',
            description: 'Verify a snapshot is valid and complete',
            inputSchema: {
                type: 'object',
                properties: {
                    snapshotId: { type: 'string', description: 'Snapshot ID to verify' },
                },
                required: ['snapshotId'],
            },
        },
        {
            name: 'check_database_health',
            description: 'Check database connectivity and health',
            inputSchema: {
                type: 'object',
                properties: {
                    database: { type: 'string', description: 'Database name' },
                },
                required: ['database'],
            },
        },
    ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
        let result: unknown

        switch (name) {
            case 'create_snapshot': {
                const params = CreateSnapshotSchema.parse(args)
                result = await createSnapshot(params.database, params.name)
                break
            }
            case 'restore_snapshot': {
                const params = RestoreSnapshotSchema.parse(args)
                result = await restoreSnapshot(params.snapshotId, params.targetDatabase)
                break
            }
            case 'list_snapshots': {
                const params = ListSnapshotsSchema.parse(args)
                result = await listSnapshots(params.database)
                break
            }
            case 'delete_snapshot': {
                const params = z.object({ snapshotId: z.string() }).parse(args)
                result = await deleteSnapshot(params.snapshotId)
                break
            }
            case 'verify_snapshot': {
                const params = z.object({ snapshotId: z.string() }).parse(args)
                result = await verifySnapshot(params.snapshotId)
                break
            }
            case 'check_database_health': {
                const params = z.object({ database: z.string() }).parse(args)
                result = await checkDatabaseHealth(params.database)
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
