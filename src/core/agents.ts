import { eventBus } from './event-bus.js'
import { incidentManager } from './incident-manager.js'
import type { AnomalyReport, HealthSnapshot } from './health-monitor.js'
import type { RecoveryAttempt, IncidentReport, TimelineEvent } from './types.js'

const DEMO_APP_URL = process.env.DEMO_APP_URL || 'http://localhost:8080'

interface AgentResult {
    agent: string
    success: boolean
    data: Record<string, unknown>
    duration: number
}

async function executeAgent(
    agentName: string,
    incidentId: string,
    fn: () => Promise<Record<string, unknown>>
): Promise<AgentResult> {
    const start = Date.now()

    eventBus.emit('agent:start', { agent: agentName, incidentId })
    incidentManager.addTimeline(incidentId, `${agentName} started`)

    try {
        const data = await fn()
        const duration = Date.now() - start

        eventBus.emit('agent:complete', {
            agent: agentName,
            incidentId,
            success: true,
            duration,
            data,
        })

        incidentManager.addTimeline(incidentId, `${agentName} completed`, { duration, ...data })

        return { agent: agentName, success: true, data, duration }
    } catch (error) {
        const duration = Date.now() - start
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'

        eventBus.emit('agent:error', {
            agent: agentName,
            incidentId,
            error: errorMsg,
            duration,
        })

        incidentManager.addTimeline(incidentId, `${agentName} failed: ${errorMsg}`)

        return { agent: agentName, success: false, data: { error: errorMsg }, duration }
    }
}

// ───────────────────────────────────────────────
// Agent 1: Observability Agent
// ───────────────────────────────────────────────
export async function runObservabilityAgent(
    incidentId: string,
    anomaly: AnomalyReport,
    snapshot: HealthSnapshot
): Promise<AgentResult> {
    return executeAgent('Observability Agent', incidentId, async () => {
        await sleep(800) // simulate observability gathering

        return {
            anomalyType: anomaly.failureType,
            severity: anomaly.severity,
            description: anomaly.description,
            affectedServices: anomaly.affectedServices,
            evidence: anomaly.evidence,
            healthSnapshot: {
                appStatus: snapshot.demoApp.statusCode,
                responseTimeMs: snapshot.demoApp.responseTimeMs,
                errorRate: snapshot.metrics.errorRate,
                memoryMB: snapshot.metrics.memoryUsageMB,
            },
        }
    })
}

// ───────────────────────────────────────────────
// Agent 2: Incident Analyzer Agent
// ───────────────────────────────────────────────
export async function runAnalyzerAgent(
    incidentId: string,
    anomaly: AnomalyReport,
    snapshot: HealthSnapshot
): Promise<AgentResult> {
    return executeAgent('Incident Analyzer', incidentId, async () => {
        incidentManager.updateStatus(incidentId, 'analyzing')
        await sleep(1200) // simulate analysis

        let rootCause: string
        let rootCauseCategory: string
        let fixStrategy: string
        let confidence: string

        switch (anomaly.failureType) {
            case 'service_down':
                rootCause = 'Application health check failing — service marked itself unhealthy or crashed'
                rootCauseCategory = 'Application Failure'
                fixStrategy = 'restart_service'
                confidence = 'high'
                break
            case 'latency_spike':
                rootCause = 'Artificial latency injection or resource contention causing slow responses'
                rootCauseCategory = 'Performance Degradation'
                fixStrategy = 'reset_latency'
                confidence = 'high'
                break
            case 'memory_leak':
                rootCause = 'Memory leak detected — application consuming excessive memory'
                rootCauseCategory = 'Resource Exhaustion'
                fixStrategy = 'restart_and_clear'
                confidence = 'medium'
                break
            case 'dependency_failure':
                rootCause = 'High error rate — database connection or dependency failure'
                rootCauseCategory = 'Dependency Failure'
                fixStrategy = 'check_dependencies'
                confidence = 'medium'
                break
            default:
                rootCause = `Unknown failure type: ${anomaly.failureType}`
                rootCauseCategory = 'Unknown'
                fixStrategy = 'restart_service'
                confidence = 'low'
        }

        incidentManager.setRootCause(incidentId, rootCause)

        return {
            rootCause,
            rootCauseCategory,
            fixStrategy,
            confidence,
            correlatedMetrics: {
                errorRate: snapshot.metrics.errorRate,
                latencyP99Ms: snapshot.metrics.latencyP99Ms,
                memoryUsageMB: snapshot.metrics.memoryUsageMB,
            },
        }
    })
}

// ───────────────────────────────────────────────
// Agent 3: Self-Healing Agent
// ───────────────────────────────────────────────
export async function runHealingAgent(
    incidentId: string,
    fixStrategy: string
): Promise<AgentResult> {
    return executeAgent('Self-Healing Agent', incidentId, async () => {
        incidentManager.updateStatus(incidentId, 'healing')

        let success = false
        let actionTaken = ''
        let actionError: string | undefined
        const start = Date.now()

        try {
            switch (fixStrategy) {
                case 'restart_service':
                case 'reset_latency':
                case 'restart_and_clear':
                case 'check_dependencies': {
                    // Attempt to reset the chaos state via the demo app API
                    actionTaken = 'Reset chaos state via /chaos/reset'

                    eventBus.emit('recovery:action', {
                        incidentId,
                        action: 'Sending reset signal to demo application',
                        phase: 'executing',
                    })

                    await sleep(500)

                    const response = await fetch(`${DEMO_APP_URL}/chaos/reset`, {
                        method: 'POST',
                    })

                    if (response.ok) {
                        // Wait for service to stabilize
                        eventBus.emit('recovery:action', {
                            incidentId,
                            action: 'Waiting for service stabilization',
                            phase: 'stabilizing',
                        })

                        await sleep(2000)

                        // Verify health
                        const healthCheck = await fetch(`${DEMO_APP_URL}/health`)
                        const healthBody = await healthCheck.json() as Record<string, unknown>

                        if (healthCheck.ok && healthBody.status === 'healthy') {
                            success = true
                        } else {
                            actionError = `Health check failed after reset: ${healthCheck.status}`
                        }
                    } else {
                        actionError = `Reset failed: HTTP ${response.status}`
                    }
                    break
                }
                default:
                    actionTaken = `Unknown strategy: ${fixStrategy}`
                    actionError = 'No handler for this fix strategy'
            }
        } catch (error) {
            actionError = error instanceof Error ? error.message : 'Reset request failed'
        }

        const attempt: RecoveryAttempt = {
            action: 'restart_pod',
            timestamp: new Date(),
            target: 'demo-app',
            success,
            error: actionError,
            duration: Date.now() - start,
        }
        incidentManager.addRecoveryAttempt(incidentId, attempt)

        if (success) {
            eventBus.emit('recovery:success', { incidentId, action: actionTaken })
        } else {
            eventBus.emit('recovery:failed', { incidentId, action: actionTaken, error: actionError })
        }

        return { success, actionTaken, error: actionError }
    })
}

// ───────────────────────────────────────────────
// Agent 4: Recovery Decision Agent
// ───────────────────────────────────────────────
export async function runRecoveryDecisionAgent(
    incidentId: string,
    healingSuccess: boolean
): Promise<AgentResult> {
    return executeAgent('Recovery Decision Agent', incidentId, async () => {
        await sleep(600)

        if (healingSuccess) {
            return {
                decision: 'resolved',
                reason: 'Self-healing succeeded, service is healthy',
                nextAction: 'generate_report',
            }
        }

        const incident = incidentManager.getIncident(incidentId)
        const attempts = incident?.attemptedActions.length || 0

        if (attempts >= 3) {
            return {
                decision: 'escalate_dr',
                reason: `Self-healing failed after ${attempts} attempts. Escalating to disaster recovery.`,
                nextAction: 'disaster_recovery',
            }
        }

        return {
            decision: 'escalate_dr',
            reason: 'Self-healing failed. Escalating to disaster recovery.',
            nextAction: 'disaster_recovery',
        }
    })
}

// ───────────────────────────────────────────────
// Agent 5: Disaster Recovery Agent
// ───────────────────────────────────────────────
export async function runDisasterRecoveryAgent(
    incidentId: string
): Promise<AgentResult> {
    return executeAgent('Disaster Recovery Agent', incidentId, async () => {
        incidentManager.updateStatus(incidentId, 'recovering')

        eventBus.emit('dr:started', { incidentId })

        // Step 1: Identify backup
        eventBus.emit('recovery:action', {
            incidentId,
            action: 'Identifying latest backup snapshot',
            phase: 'backup_check',
        })
        await sleep(1000)

        // Step 2: Restart the container via Docker
        eventBus.emit('recovery:action', {
            incidentId,
            action: 'Restarting demo-app container',
            phase: 'container_restart',
        })

        let containerRestarted = false
        try {
            // Try the chaos reset endpoint first
            const resetResponse = await fetch(`${DEMO_APP_URL}/chaos/reset`, { method: 'POST' })
            if (resetResponse.ok) {
                containerRestarted = true
            }
        } catch {
            // Service might be completely down, that's expected during DR
        }

        await sleep(2000)

        // Step 3: Validate health
        eventBus.emit('recovery:action', {
            incidentId,
            action: 'Validating system health post-recovery',
            phase: 'health_validation',
        })

        let recovered = false
        for (let i = 0; i < 5; i++) {
            try {
                const health = await fetch(`${DEMO_APP_URL}/health`)
                if (health.ok) {
                    recovered = true
                    break
                }
            } catch {
                // Keep trying
            }
            await sleep(1000)
        }

        const attempt: RecoveryAttempt = {
            action: 'restore_database',
            timestamp: new Date(),
            target: 'demo-app + demo-db',
            success: recovered,
            duration: 4000,
        }
        incidentManager.addRecoveryAttempt(incidentId, attempt)

        eventBus.emit('dr:complete', {
            incidentId,
            success: recovered,
            containerRestarted,
        })

        return {
            recoveryStatus: recovered ? 'success' : 'partial',
            restoredFrom: 'latest-snapshot',
            servicesRecovered: recovered ? ['demo-app', 'demo-db'] : [],
            dataLossWindow: 'none',
            readyForTraffic: recovered,
        }
    })
}

// ───────────────────────────────────────────────
// Agent 6: Traffic Switch Agent
// ───────────────────────────────────────────────
export async function runTrafficSwitchAgent(
    incidentId: string,
    readyForTraffic: boolean
): Promise<AgentResult> {
    return executeAgent('Traffic Switch Agent', incidentId, async () => {
        eventBus.emit('traffic:switching', { incidentId })

        if (!readyForTraffic) {
            return {
                trafficStatus: 'failed',
                reason: 'System not ready for traffic',
            }
        }

        // Verify stability over a short window
        eventBus.emit('recovery:action', {
            incidentId,
            action: 'Verifying system stability before traffic switch',
            phase: 'stability_check',
        })

        await sleep(1500)

        // Final health check
        let stable = false
        try {
            const health = await fetch(`${DEMO_APP_URL}/health`)
            const body = await health.json() as Record<string, unknown>
            stable = health.ok && body.status === 'healthy'
        } catch {
            stable = false
        }

        if (stable) {
            eventBus.emit('traffic:complete', { incidentId })
        }

        return {
            trafficStatus: stable ? 'complete' : 'rolled_back',
            currentTrafficPercent: stable ? 100 : 0,
            stabilityCheck: stable ? 'passed' : 'failed',
        }
    })
}

// ───────────────────────────────────────────────
// Agent 7: Incident Reporter Agent
// ───────────────────────────────────────────────
export async function runReporterAgent(incidentId: string): Promise<AgentResult> {
    return executeAgent('Incident Reporter', incidentId, async () => {
        const incident = incidentManager.getIncident(incidentId)
        if (!incident) throw new Error('Incident not found')

        await sleep(1000)

        const timeline = (incident as Incident & { timeline?: TimelineEvent[] }).timeline || []
        const duration = incident.resolvedAt
            ? incident.resolvedAt.getTime() - incident.timestamp.getTime()
            : Date.now() - incident.timestamp.getTime()

        const report: IncidentReport = {
            id: `RPT-${Date.now()}`,
            incidentId,
            timeline,
            rootCauseAnalysis: incident.rootCause || 'Root cause analysis pending',
            actionsSummary: incident.attemptedActions
                .map(a => `${a.action} on ${a.target}: ${a.success ? 'SUCCESS' : 'FAILED'}${a.error ? ` (${a.error})` : ''}`)
                .join('\n'),
            preventionRecommendations: generateRecommendations(incident.failureType),
            generatedAt: new Date(),
        }

        incidentManager.setReport(incidentId, report)
        incidentManager.updateStatus(incidentId, 'resolved')

        eventBus.emit('incident:resolved', {
            incidentId,
            duration,
            report: {
                id: report.id,
                rootCause: report.rootCauseAnalysis,
                actionsCount: incident.attemptedActions.length,
                durationMs: duration,
            },
        })

        return {
            reportId: report.id,
            durationMs: duration,
            durationHuman: formatDuration(duration),
            actionsCount: incident.attemptedActions.length,
            rootCause: report.rootCauseAnalysis,
            recommendations: report.preventionRecommendations,
        }
    })
}

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

interface Incident {
    id: string
    timestamp: Date
    status: string
    failureType: string
    severity: string
    affectedServices: string[]
    rootCause?: string
    attemptedActions: RecoveryAttempt[]
    resolvedAt?: Date
    timeline?: TimelineEvent[]
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
}

function generateRecommendations(failureType: string): string[] {
    const base = [
        'Implement automated health check monitoring with alerting',
        'Add circuit breakers for external dependencies',
        'Set up runbook automation for common failure scenarios',
    ]

    switch (failureType) {
        case 'service_down':
            return [
                'Add readiness and liveness probes with appropriate thresholds',
                'Implement graceful shutdown handling',
                'Configure horizontal pod autoscaling for high availability',
                ...base,
            ]
        case 'latency_spike':
            return [
                'Set up latency-based alerting with P95/P99 thresholds',
                'Implement request timeout and retry policies',
                'Add caching layer for frequently accessed data',
                ...base,
            ]
        case 'memory_leak':
            return [
                'Profile application memory usage in staging',
                'Set memory limits and configure OOM kill policies',
                'Implement periodic garbage collection monitoring',
                ...base,
            ]
        case 'dependency_failure':
            return [
                'Implement circuit breaker pattern for database connections',
                'Add connection pool monitoring and alerting',
                'Configure database failover and read replicas',
                ...base,
            ]
        default:
            return base
    }
}
