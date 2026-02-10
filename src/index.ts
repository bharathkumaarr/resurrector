import { orchestrator } from './core/orchestrator.js'
import { createApiServer } from './core/api-server.js'
import { eventBus } from './core/event-bus.js'

const API_PORT = parseInt(process.env.API_PORT || '4000', 10)

console.log(`
╔══════════════════════════════════════════════════════╗
║                                                      ║
║   ██████╗ ███████╗███████╗██╗   ██╗██████╗           ║
║   ██╔══██╗██╔════╝██╔════╝██║   ██║██╔══██╗          ║
║   ██████╔╝█████╗  ███████╗██║   ██║██████╔╝          ║
║   ██╔══██╗██╔══╝  ╚════██║██║   ██║██╔══██╗          ║
║   ██║  ██║███████╗███████║╚██████╔╝██║  ██║          ║
║   ╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝          ║
║                                                      ║
║   Autonomous Self-Healing & Disaster Recovery        ║
║   Platform — Powered by MCP Orchestration            ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`)

// Log key events to console
eventBus.onEvent((event) => {
    const timestamp = event.timestamp.toISOString().split('T')[1].split('.')[0]
    const icon = getEventIcon(event.type)
    console.log(`  ${icon} [${timestamp}] ${event.type}: ${JSON.stringify(event.data).substring(0, 120)}`)
})

function getEventIcon(type: string): string {
    if (type.startsWith('health:healthy')) return '💚'
    if (type.startsWith('health:degraded')) return '🟡'
    if (type.startsWith('health:check')) return '🔍'
    if (type.startsWith('anomaly:')) return '🚨'
    if (type.startsWith('agent:start')) return '🤖'
    if (type.startsWith('agent:complete')) return '✅'
    if (type.startsWith('agent:error')) return '❌'
    if (type.startsWith('incident:created')) return '🔥'
    if (type.startsWith('incident:resolved')) return '🎉'
    if (type.startsWith('incident:')) return '📋'
    if (type.startsWith('recovery:success')) return '💊'
    if (type.startsWith('recovery:failed')) return '💔'
    if (type.startsWith('recovery:')) return '🔧'
    if (type.startsWith('dr:')) return '🏥'
    if (type.startsWith('traffic:')) return '🔀'
    if (type.startsWith('report:')) return '📝'
    if (type.startsWith('chaos:')) return '💥'
    return '📌'
}

// Start API server
createApiServer(API_PORT)

// Start orchestrator
orchestrator.start()

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Resurrector] Shutting down gracefully...')
    orchestrator.stop()
    process.exit(0)
})

process.on('SIGTERM', () => {
    console.log('\n[Resurrector] Shutting down...')
    orchestrator.stop()
    process.exit(0)
})
