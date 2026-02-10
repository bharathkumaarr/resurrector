import { eventBus } from './event-bus.js'
import type {
    Incident,
    IncidentStatus,
    IncidentReport,
    RecoveryAttempt,
    TimelineEvent,
    FailureType,
    Severity,
} from './types.js'

function generateId(): string {
    return `INC-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`
}

class IncidentManager {
    private incidents: Map<string, Incident> = new Map()

    createIncident(
        failureType: FailureType,
        severity: Severity,
        affectedServices: string[]
    ): Incident {
        const incident: Incident = {
            id: generateId(),
            timestamp: new Date(),
            status: 'detected',
            failureType,
            severity,
            affectedServices,
            attemptedActions: [],
        }

        this.incidents.set(incident.id, incident)

        eventBus.emit('incident:created', {
            incidentId: incident.id,
            failureType,
            severity,
            affectedServices,
        })

        this.addTimeline(incident.id, 'Incident detected', {
            failureType,
            severity,
            affectedServices,
        })

        return incident
    }

    updateStatus(incidentId: string, status: IncidentStatus): void {
        const incident = this.incidents.get(incidentId)
        if (!incident) return

        incident.status = status

        if (status === 'resolved') {
            incident.resolvedAt = new Date()
        }

        eventBus.emit('incident:update', {
            incidentId,
            status,
            timestamp: new Date().toISOString(),
        })
    }

    addRecoveryAttempt(incidentId: string, attempt: RecoveryAttempt): void {
        const incident = this.incidents.get(incidentId)
        if (!incident) return

        incident.attemptedActions.push(attempt)

        eventBus.emit('recovery:action', {
            incidentId,
            action: attempt.action,
            target: attempt.target,
            success: attempt.success,
            error: attempt.error,
            duration: attempt.duration,
        })

        this.addTimeline(incidentId, `Recovery action: ${attempt.action}`, {
            target: attempt.target,
            success: attempt.success,
            error: attempt.error,
        })
    }

    setRootCause(incidentId: string, rootCause: string): void {
        const incident = this.incidents.get(incidentId)
        if (!incident) return
        incident.rootCause = rootCause
    }

    setReport(incidentId: string, report: IncidentReport): void {
        const incident = this.incidents.get(incidentId)
        if (!incident) return
        incident.report = report

        eventBus.emit('report:generated', {
            incidentId,
            report,
        })
    }

    addTimeline(incidentId: string, event: string, details?: Record<string, unknown>): void {
        const incident = this.incidents.get(incidentId)
        if (!incident) return

        if (!incident.timeline) {
            (incident as Incident & { timeline: TimelineEvent[] }).timeline = []
        }

        const timelineEntry: TimelineEvent = {
            timestamp: new Date(),
            event,
            details,
        }

            ; (incident as Incident & { timeline: TimelineEvent[] }).timeline.push(timelineEntry)
    }

    getIncident(incidentId: string): Incident | undefined {
        return this.incidents.get(incidentId)
    }

    getActiveIncident(): Incident | undefined {
        return Array.from(this.incidents.values())
            .filter(i => i.status !== 'resolved' && i.status !== 'failed')
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]
    }

    getAllIncidents(): Incident[] {
        return Array.from(this.incidents.values())
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    }

    getIncidentCount(): number {
        return this.incidents.size
    }
}

export const incidentManager = new IncidentManager()
