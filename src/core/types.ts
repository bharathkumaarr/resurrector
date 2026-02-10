export type Severity = 'low' | 'medium' | 'high' | 'critical'

export type FailureType =
    | 'crashloop'
    | 'latency_spike'
    | 'memory_leak'
    | 'service_down'
    | 'config_error'
    | 'dependency_failure'
    | 'resource_exhaustion'

export type RecoveryAction =
    | 'restart_pod'
    | 'rollback_deployment'
    | 'scale_up'
    | 'scale_down'
    | 'reload_config'
    | 'clear_cache'
    | 'restore_database'
    | 'switch_traffic'

export type IncidentStatus =
    | 'detected'
    | 'analyzing'
    | 'healing'
    | 'escalated'
    | 'recovering'
    | 'resolved'
    | 'failed'

export interface Incident {
    id: string
    timestamp: Date
    status: IncidentStatus
    failureType: FailureType
    severity: Severity
    affectedServices: string[]
    rootCause?: string
    attemptedActions: RecoveryAttempt[]
    resolvedAt?: Date
    report?: IncidentReport
}

export interface RecoveryAttempt {
    action: RecoveryAction
    timestamp: Date
    target: string
    success: boolean
    error?: string
    duration: number
}

export interface IncidentReport {
    id: string
    incidentId: string
    timeline: TimelineEvent[]
    rootCauseAnalysis: string
    actionsSummary: string
    preventionRecommendations: string[]
    generatedAt: Date
}

export interface TimelineEvent {
    timestamp: Date
    event: string
    details?: Record<string, unknown>
}

export interface ServiceHealth {
    name: string
    namespace: string
    status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
    replicas: {
        desired: number
        ready: number
        available: number
    }
    lastCheck: Date
    metrics?: {
        cpuUsage: number
        memoryUsage: number
        latencyP99: number
        errorRate: number
    }
}

export interface PodInfo {
    name: string
    namespace: string
    status: string
    restarts: number
    age: string
    node: string
    ready: boolean
}

export interface DeploymentInfo {
    name: string
    namespace: string
    replicas: number
    readyReplicas: number
    updatedReplicas: number
    image: string
    strategy: string
}

export interface DatabaseSnapshot {
    id: string
    name: string
    database: string
    createdAt: Date
    size: number
    status: 'creating' | 'available' | 'restoring' | 'failed'
}

export interface MetricQuery {
    query: string
    start?: Date
    end?: Date
    step?: string
}

export interface MetricResult {
    metric: Record<string, string>
    values: Array<[number, string]>
}

export interface LogEntry {
    timestamp: Date
    pod: string
    container: string
    message: string
    level?: string
}

export interface ConfigMap {
    name: string
    namespace: string
    data: Record<string, string>
}

export interface AgentContext {
    incidentId?: string
    previousActions: RecoveryAttempt[]
    serviceHealth: Map<string, ServiceHealth>
    startTime: Date
}
