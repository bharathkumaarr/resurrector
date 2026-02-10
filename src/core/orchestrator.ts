import { eventBus } from './event-bus.js'
import { incidentManager } from './incident-manager.js'
import { getHealthSnapshot, detectAnomalies } from './health-monitor.js'
import type { HealthSnapshot } from './health-monitor.js'
import {
    runObservabilityAgent,
    runAnalyzerAgent,
    runHealingAgent,
    runRecoveryDecisionAgent,
    runDisasterRecoveryAgent,
    runTrafficSwitchAgent,
    runReporterAgent,
} from './agents.js'

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000', 10)

export class Orchestrator {
    private running = false
    private pollTimer: ReturnType<typeof setInterval> | null = null
    private pipelineRunning = false
    private lastHealthSnapshot: HealthSnapshot | null = null
    private consecutiveHealthy = 0
    private consecutiveUnhealthy = 0

    start(): void {
        if (this.running) return
        this.running = true

        console.log(`[Orchestrator] Starting monitoring loop (interval: ${POLL_INTERVAL}ms)`)
        eventBus.emit('system:status', { status: 'monitoring', message: 'Orchestrator started' })

        this.pollTimer = setInterval(() => this.monitoringLoop(), POLL_INTERVAL)
        // Run immediately on start
        this.monitoringLoop()
    }

    stop(): void {
        this.running = false
        if (this.pollTimer) {
            clearInterval(this.pollTimer)
            this.pollTimer = null
        }
        console.log('[Orchestrator] Stopped')
        eventBus.emit('system:status', { status: 'stopped', message: 'Orchestrator stopped' })
    }

    private async monitoringLoop(): Promise<void> {
        if (this.pipelineRunning) return

        try {
            const snapshot = await getHealthSnapshot()
            this.lastHealthSnapshot = snapshot

            eventBus.emit('health:check', {
                healthy: snapshot.demoApp.healthy,
                statusCode: snapshot.demoApp.statusCode,
                responseTimeMs: snapshot.demoApp.responseTimeMs,
                errorRate: snapshot.metrics.errorRate,
                memoryMB: snapshot.metrics.memoryUsageMB,
                timestamp: snapshot.timestamp.toISOString(),
            })

            const anomaly = detectAnomalies(snapshot)

            if (anomaly) {
                this.consecutiveUnhealthy++
                this.consecutiveHealthy = 0

                // Only trigger pipeline after 2 consecutive unhealthy checks
                // to avoid false positives
                if (this.consecutiveUnhealthy >= 2 && !this.pipelineRunning) {
                    const activeIncident = incidentManager.getActiveIncident()
                    if (!activeIncident) {
                        console.log(`[Orchestrator] Anomaly confirmed: ${anomaly.failureType} (${anomaly.severity})`)
                        eventBus.emit('anomaly:detected', {
                            failureType: anomaly.failureType,
                            severity: anomaly.severity,
                            description: anomaly.description,
                        })
                        await this.runPipeline(anomaly, snapshot)
                    }
                }
            } else {
                this.consecutiveHealthy++
                this.consecutiveUnhealthy = 0
            }
        } catch (error) {
            console.error('[Orchestrator] Monitoring error:', error)
        }
    }

    private async runPipeline(
        anomaly: ReturnType<typeof detectAnomalies> & object,
        snapshot: HealthSnapshot
    ): Promise<void> {
        this.pipelineRunning = true

        try {
            // Create incident
            const incident = incidentManager.createIncident(
                anomaly.failureType,
                anomaly.severity,
                anomaly.affectedServices
            )
            const incidentId = incident.id
            console.log(`[Orchestrator] Pipeline started for incident ${incidentId}`)

            // Agent 1: Observability Agent
            await runObservabilityAgent(incidentId, anomaly, snapshot)

            // Agent 2: Incident Analyzer
            const analyzerResult = await runAnalyzerAgent(incidentId, anomaly, snapshot)
            const fixStrategy = analyzerResult.data.fixStrategy as string || 'restart_service'

            // Agent 3: Self-Healing Agent
            const healingResult = await runHealingAgent(incidentId, fixStrategy)
            const healingSuccess = healingResult.data.success as boolean

            // Agent 4: Recovery Decision
            const decisionResult = await runRecoveryDecisionAgent(incidentId, healingSuccess)
            const decision = decisionResult.data.decision as string

            if (decision === 'resolved') {
                // Direct to reporter
                await runReporterAgent(incidentId)
                console.log(`[Orchestrator] Incident ${incidentId} resolved via self-healing`)
            } else if (decision === 'escalate_dr') {
                // Agent 5: Disaster Recovery
                incidentManager.updateStatus(incidentId, 'escalated')
                const drResult = await runDisasterRecoveryAgent(incidentId)
                const readyForTraffic = drResult.data.readyForTraffic as boolean

                // Agent 6: Traffic Switch
                await runTrafficSwitchAgent(incidentId, readyForTraffic)

                // Agent 7: Reporter
                await runReporterAgent(incidentId)
                console.log(`[Orchestrator] Incident ${incidentId} resolved via disaster recovery`)
            }

            // Reset counters
            this.consecutiveUnhealthy = 0
        } catch (error) {
            console.error('[Orchestrator] Pipeline error:', error)
        } finally {
            this.pipelineRunning = false
        }
    }

    getStatus(): Record<string, unknown> {
        return {
            running: this.running,
            pipelineRunning: this.pipelineRunning,
            lastHealthSnapshot: this.lastHealthSnapshot,
            consecutiveHealthy: this.consecutiveHealthy,
            consecutiveUnhealthy: this.consecutiveUnhealthy,
            activeIncident: incidentManager.getActiveIncident(),
            totalIncidents: incidentManager.getIncidentCount(),
        }
    }
}

export const orchestrator = new Orchestrator()
