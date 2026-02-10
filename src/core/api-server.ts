import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import * as http from 'http'
import * as path from 'path'
import * as url from 'url'
import { eventBus } from './event-bus.js'
import { incidentManager } from './incident-manager.js'
import { orchestrator } from './orchestrator.js'
import { getHealthSnapshot } from './health-monitor.js'

const DEMO_APP_URL = process.env.DEMO_APP_URL || 'http://localhost:8080'

const __filename = url.fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function createApiServer(port: number = 4000): http.Server {
    const app = express()
    app.use(express.json())

    // Serve dashboard static files
    const dashboardPath = path.resolve(__dirname, '../../dashboard')
    app.use(express.static(dashboardPath))

    // ─── API Routes ────────────────────────────────

    // System status
    app.get('/api/status', async (_req, res) => {
        try {
            const snapshot = await getHealthSnapshot()
            const status = orchestrator.getStatus()

            res.json({
                system: {
                    demoApp: snapshot.demoApp,
                    database: snapshot.database,
                    prometheus: snapshot.prometheus,
                },
                metrics: snapshot.metrics,
                orchestrator: {
                    running: status.running,
                    pipelineRunning: status.pipelineRunning,
                    consecutiveHealthy: status.consecutiveHealthy,
                    consecutiveUnhealthy: status.consecutiveUnhealthy,
                    totalIncidents: status.totalIncidents,
                },
                activeIncident: status.activeIncident || null,
                timestamp: new Date().toISOString(),
            })
        } catch (error) {
            res.status(500).json({
                error: error instanceof Error ? error.message : 'Internal error',
            })
        }
    })

    // Incident list
    app.get('/api/incidents', (_req, res) => {
        const incidents = incidentManager.getAllIncidents()
        res.json(incidents)
    })

    // Specific incident
    app.get('/api/incidents/:id', (req, res) => {
        const incident = incidentManager.getIncident(req.params.id)
        if (!incident) {
            res.status(404).json({ error: 'Incident not found' })
            return
        }
        res.json(incident)
    })

    // Event history
    app.get('/api/events', (req, res) => {
        const limit = parseInt(req.query.limit as string) || 100
        const events = eventBus.getHistory(limit)
        res.json(events)
    })

    // Chaos injection endpoints (proxied to demo app)
    app.post('/api/chaos/:type', async (req, res) => {
        const { type } = req.params
        const chaosMap: Record<string, string> = {
            crash: '/chaos/crash',
            unhealthy: '/chaos/unhealthy',
            healthy: '/chaos/healthy',
            memory: '/chaos/memory-leak',
            latency: '/chaos/latency/5000',
            reset: '/chaos/reset',
        }

        const endpoint = chaosMap[type]
        if (!endpoint) {
            res.status(400).json({ error: `Unknown chaos type: ${type}. Available: ${Object.keys(chaosMap).join(', ')}` })
            return
        }

        try {
            const response = await fetch(`${DEMO_APP_URL}${endpoint}`, { method: 'POST' })
            const data = await response.json()

            eventBus.emit('chaos:injected', { type, endpoint, response: data })

            res.json({
                success: true,
                chaosType: type,
                message: (data as Record<string, unknown>).message,
            })
        } catch (error) {
            res.status(502).json({
                error: `Failed to inject chaos: ${error instanceof Error ? error.message : 'Unknown error'}`,
            })
        }
    })

    // Health check for the orchestrator itself
    app.get('/api/health', (_req, res) => {
        res.json({ status: 'healthy', service: 'resurrector-orchestrator' })
    })

    // Metrics snapshot
    app.get('/api/metrics', async (_req, res) => {
        try {
            const snapshot = await getHealthSnapshot()
            res.json(snapshot.metrics)
        } catch (error) {
            res.status(500).json({ error: 'Failed to get metrics' })
        }
    })

    // Dashboard fallback (Express 5 named splat syntax)
    app.get('/{*path}', (_req, res) => {
        res.sendFile(path.join(dashboardPath, 'index.html'))
    })

    // ─── HTTP + WebSocket Server ────────────────────

    const server = http.createServer(app)
    const wss = new WebSocketServer({ server, path: '/ws' })

    // Track connected clients
    const clients = new Set<WebSocket>()

    wss.on('connection', (ws) => {
        clients.add(ws)
        console.log(`[WS] Client connected (${clients.size} total)`)

        // Send current state on connect
        const status = orchestrator.getStatus()
        ws.send(JSON.stringify({
            type: 'system:status',
            timestamp: new Date().toISOString(),
            data: {
                status: 'connected',
                orchestratorRunning: status.running,
                totalIncidents: status.totalIncidents,
                activeIncident: status.activeIncident || null,
            },
        }))

        // Send recent event history
        const history = eventBus.getHistory(50)
        if (history.length > 0) {
            ws.send(JSON.stringify({
                type: 'history',
                timestamp: new Date().toISOString(),
                data: { events: history },
            }))
        }

        ws.on('close', () => {
            clients.delete(ws)
            console.log(`[WS] Client disconnected (${clients.size} total)`)
        })

        ws.on('error', (err) => {
            console.error('[WS] Client error:', err.message)
            clients.delete(ws)
        })
    })

    // Broadcast all events to WebSocket clients
    eventBus.onEvent((event) => {
        const message = JSON.stringify(event)
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message)
            }
        }
    })

    server.listen(port, () => {
        console.log(`[API Server] Dashboard: http://localhost:${port}`)
        console.log(`[API Server] WebSocket: ws://localhost:${port}/ws`)
        console.log(`[API Server] API: http://localhost:${port}/api/status`)
    })

    return server
}
