import { EventEmitter } from 'events'

export type EventType =
    | 'health:check'
    | 'health:healthy'
    | 'health:degraded'
    | 'anomaly:detected'
    | 'agent:start'
    | 'agent:complete'
    | 'agent:error'
    | 'incident:created'
    | 'incident:update'
    | 'incident:resolved'
    | 'recovery:action'
    | 'recovery:success'
    | 'recovery:failed'
    | 'dr:started'
    | 'dr:complete'
    | 'traffic:switching'
    | 'traffic:complete'
    | 'report:generated'
    | 'system:status'
    | 'chaos:injected'

export interface BusEvent {
    type: EventType
    timestamp: Date
    data: Record<string, unknown>
}

class ResurrectorEventBus extends EventEmitter {
    private eventHistory: BusEvent[] = []
    private maxHistory = 500

    emit(type: EventType, data: Record<string, unknown> = {}): boolean {
        const event: BusEvent = {
            type,
            timestamp: new Date(),
            data,
        }

        this.eventHistory.push(event)
        if (this.eventHistory.length > this.maxHistory) {
            this.eventHistory = this.eventHistory.slice(-this.maxHistory)
        }

        return super.emit('event', event)
    }

    onEvent(handler: (event: BusEvent) => void): void {
        this.on('event', handler)
    }

    getHistory(limit = 100): BusEvent[] {
        return this.eventHistory.slice(-limit)
    }

    getHistoryByType(type: EventType, limit = 50): BusEvent[] {
        return this.eventHistory
            .filter(e => e.type === type)
            .slice(-limit)
    }

    clearHistory(): void {
        this.eventHistory = []
    }
}

export const eventBus = new ResurrectorEventBus()
