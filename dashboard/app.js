// Resurrector Live Dashboard — Frontend Logic
(function () {
    'use strict'

    const WS_URL = `ws://${window.location.host}/ws`
    const API_URL = ''

    // ─── State ─────────────────────────────────
    let ws = null
    let wsConnected = false
    let systemStatus = 'unknown'
    let activeAgentIndex = -1
    let incidents = []
    let timelineEvents = []

    const AGENTS = [
        { name: 'Observability', icon: '👁️', key: 'Observability Agent' },
        { name: 'Analyzer', icon: '🔬', key: 'Incident Analyzer' },
        { name: 'Self-Healer', icon: '💊', key: 'Self-Healing Agent' },
        { name: 'Decision', icon: '⚖️', key: 'Recovery Decision Agent' },
        { name: 'Disaster\nRecovery', icon: '🏥', key: 'Disaster Recovery Agent' },
        { name: 'Traffic\nSwitch', icon: '🔀', key: 'Traffic Switch Agent' },
        { name: 'Reporter', icon: '📝', key: 'Incident Reporter' },
    ]

    // ─── DOM References ─────────────────────────
    const $ = (sel) => document.querySelector(sel)
    const $$ = (sel) => document.querySelectorAll(sel)

    // ─── WebSocket ──────────────────────────────
    function connectWebSocket() {
        ws = new WebSocket(WS_URL)

        ws.onopen = () => {
            wsConnected = true
            updateWsIndicator()
            console.log('[WS] Connected')
        }

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data)
                handleEvent(data)
            } catch (err) {
                console.error('[WS] Parse error:', err)
            }
        }

        ws.onclose = () => {
            wsConnected = false
            updateWsIndicator()
            console.log('[WS] Disconnected, reconnecting in 3s...')
            setTimeout(connectWebSocket, 3000)
        }

        ws.onerror = (err) => {
            console.error('[WS] Error:', err)
        }
    }

    function updateWsIndicator() {
        const dot = $('.ws-dot')
        const label = $('.ws-label')
        if (dot) dot.classList.toggle('connected', wsConnected)
        if (label) label.textContent = wsConnected ? 'Live' : 'Disconnected'
    }

    // ─── Event Handler ──────────────────────────
    function handleEvent(event) {
        // Handle history batch
        if (event.type === 'history') {
            if (event.data && event.data.events) {
                event.data.events.forEach(e => addTimelineEvent(e))
            }
            return
        }

        // Handle system status on first connect
        if (event.type === 'system:status') {
            if (event.data && event.data.orchestratorRunning !== undefined) {
                systemStatus = 'monitoring'
                updateSystemBadge('healthy')
            }
            return
        }

        // Add to timeline
        addTimelineEvent(event)

        // Handle specific event types
        switch (event.type) {
            case 'health:check':
                updateHealthPanel(event.data)
                updateMetrics(event.data)
                break
            case 'health:healthy':
                updateSystemBadge('healthy')
                break
            case 'health:degraded':
                updateSystemBadge('unhealthy')
                break
            case 'anomaly:detected':
                updateSystemBadge('unhealthy')
                resetAgentPipeline()
                break
            case 'agent:start':
                setAgentActive(event.data.agent)
                break
            case 'agent:complete':
                setAgentComplete(event.data.agent)
                break
            case 'agent:error':
                setAgentFailed(event.data.agent)
                break
            case 'incident:created':
                updateSystemBadge('recovering')
                break
            case 'incident:resolved':
                updateSystemBadge('healthy')
                showIncidentReport(event.data)
                setTimeout(resetAgentPipeline, 5000)
                break
            case 'chaos:injected':
                flashChaosButton(event.data.type)
                break
        }
    }

    // ─── Timeline ────────────────────────────────
    function addTimelineEvent(event) {
        timelineEvents.unshift(event)
        if (timelineEvents.length > 200) timelineEvents.pop()
        renderTimeline()
    }

    function renderTimeline() {
        const container = $('.timeline-scroll')
        if (!container) return

        const eventsToShow = timelineEvents.slice(0, 50)

        if (eventsToShow.length === 0) {
            container.innerHTML = '<div class="timeline-empty">Waiting for events... System is being monitored.</div>'
            return
        }

        container.innerHTML = eventsToShow.map(event => {
            const icon = getEventIcon(event.type)
            const time = formatTime(event.timestamp)
            const message = formatEventMessage(event)
            const typeColor = getTypeColor(event.type)

            return `
                <div class="timeline-event">
                    <div class="timeline-icon">${icon}</div>
                    <div class="timeline-content">
                        <div class="timeline-type" style="color:${typeColor}">${event.type}</div>
                        <div class="timeline-message">${message}</div>
                    </div>
                    <div class="timeline-time">${time}</div>
                </div>
            `
        }).join('')
    }

    function getEventIcon(type) {
        const icons = {
            'health:check': '🔍',
            'health:healthy': '💚',
            'health:degraded': '🟡',
            'anomaly:detected': '🚨',
            'agent:start': '🤖',
            'agent:complete': '✅',
            'agent:error': '❌',
            'incident:created': '🔥',
            'incident:update': '📋',
            'incident:resolved': '🎉',
            'recovery:action': '🔧',
            'recovery:success': '💊',
            'recovery:failed': '💔',
            'dr:started': '🏥',
            'dr:complete': '🏥',
            'traffic:switching': '🔀',
            'traffic:complete': '🔀',
            'report:generated': '📝',
            'chaos:injected': '💥',
            'system:status': '📌',
        }
        return icons[type] || '📌'
    }

    function getTypeColor(type) {
        if (type.includes('healthy') || type.includes('success') || type.includes('resolved') || type.includes('complete')) return 'var(--green)'
        if (type.includes('anomaly') || type.includes('failed') || type.includes('degraded') || type.includes('error')) return 'var(--red)'
        if (type.includes('chaos') || type.includes('incident:created')) return 'var(--red)'
        if (type.includes('agent:start') || type.includes('recovery:action')) return 'var(--amber)'
        return 'var(--accent)'
    }

    function formatEventMessage(event) {
        const d = event.data || {}
        switch (event.type) {
            case 'health:check':
                return `Status: ${d.healthy ? 'Healthy' : 'Unhealthy'} | Response: ${d.responseTimeMs || 0}ms | Errors: ${(d.errorRate || 0).toFixed(1)}%`
            case 'anomaly:detected':
                return `${d.description || d.failureType} [${d.severity}]`
            case 'agent:start':
                return `${d.agent} started processing incident ${d.incidentId}`
            case 'agent:complete':
                return `${d.agent} completed in ${d.duration}ms`
            case 'agent:error':
                return `${d.agent} failed: ${d.error}`
            case 'incident:created':
                return `New incident: ${d.failureType} | Severity: ${d.severity} | Services: ${(d.affectedServices || []).join(', ')}`
            case 'incident:resolved':
                return `Resolved in ${formatDuration(d.duration || d.durationMs)} | Actions: ${d.actionsCount || d.report?.actionsCount || 0}`
            case 'recovery:action':
                return `${d.action} [${d.phase || 'executing'}]`
            case 'chaos:injected':
                return `Chaos injected: ${d.type}`
            default:
                return JSON.stringify(d).substring(0, 150)
        }
    }

    function formatTime(ts) {
        if (!ts) return ''
        const d = new Date(ts)
        return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }

    function formatDuration(ms) {
        if (!ms) return '?'
        const s = Math.floor(ms / 1000)
        if (s < 60) return `${s}s`
        return `${Math.floor(s / 60)}m ${s % 60}s`
    }

    // ─── Agent Pipeline ──────────────────────────
    function renderPipeline() {
        const container = $('.pipeline')
        if (!container) return

        container.innerHTML = AGENTS.map((agent, i) => {
            const arrow = i < AGENTS.length - 1 ? '<div class="pipeline-arrow" data-index="' + i + '">→</div>' : ''
            const nameLines = agent.name.split('\n').join('<br>')
            return `
                <div class="agent-node" data-agent="${agent.key}" id="agent-${i}">
                    <div class="agent-icon">${agent.icon}</div>
                    <div class="agent-name">${nameLines}</div>
                    <div class="agent-status">idle</div>
                </div>
                ${arrow}
            `
        }).join('')
    }

    function setAgentActive(agentKey) {
        const index = AGENTS.findIndex(a => a.key === agentKey)
        if (index === -1) return

        // Mark previous agents as complete
        for (let i = 0; i < index; i++) {
            const node = $(`#agent-${i}`)
            if (node && !node.classList.contains('complete') && !node.classList.contains('failed')) {
                node.classList.add('complete')
                node.classList.remove('active')
                const status = node.querySelector('.agent-status')
                if (status) status.textContent = 'done'
            }
        }

        const node = $(`#agent-${index}`)
        if (node) {
            node.classList.add('active')
            node.classList.remove('complete', 'failed')
            const status = node.querySelector('.agent-status')
            if (status) status.innerHTML = '<span class="spinner"></span> running'
        }

        // Activate arrow before this agent
        if (index > 0) {
            const arrow = $(`.pipeline-arrow[data-index="${index - 1}"]`)
            if (arrow) arrow.classList.add('active')
        }

        activeAgentIndex = index
    }

    function setAgentComplete(agentKey) {
        const index = AGENTS.findIndex(a => a.key === agentKey)
        if (index === -1) return

        const node = $(`#agent-${index}`)
        if (node) {
            node.classList.remove('active')
            node.classList.add('complete')
            const status = node.querySelector('.agent-status')
            if (status) status.textContent = 'done ✓'
        }
    }

    function setAgentFailed(agentKey) {
        const index = AGENTS.findIndex(a => a.key === agentKey)
        if (index === -1) return

        const node = $(`#agent-${index}`)
        if (node) {
            node.classList.remove('active')
            node.classList.add('failed')
            const status = node.querySelector('.agent-status')
            if (status) status.textContent = 'failed ✗'
        }
    }

    function resetAgentPipeline() {
        AGENTS.forEach((_, i) => {
            const node = $(`#agent-${i}`)
            if (node) {
                node.classList.remove('active', 'complete', 'failed')
                const status = node.querySelector('.agent-status')
                if (status) status.textContent = 'idle'
            }
            const arrow = $(`.pipeline-arrow[data-index="${i}"]`)
            if (arrow) arrow.classList.remove('active')
        })
        activeAgentIndex = -1
    }

    // ─── Health Panel ────────────────────────────
    function updateHealthPanel(data) {
        const items = {
            'health-app': { healthy: data.healthy, icon: '🖥️' },
            'health-db': { healthy: data.healthy, icon: '🗄️' },
            'health-prom': { healthy: true, icon: '📊' },
        }

        for (const [id, info] of Object.entries(items)) {
            const el = document.getElementById(id)
            if (!el) continue
            el.classList.toggle('healthy', info.healthy)
            el.classList.toggle('unhealthy', !info.healthy)
            const statusEl = el.querySelector('.health-status')
            if (statusEl) {
                statusEl.textContent = info.healthy ? 'HEALTHY' : 'DOWN'
                statusEl.classList.toggle('up', info.healthy)
                statusEl.classList.toggle('down', !info.healthy)
            }
        }
    }

    // ─── Metrics ─────────────────────────────────
    function updateMetrics(data) {
        setMetric('metric-response', data.responseTimeMs || 0, 'ms', v => v > 2000 ? 'danger' : v > 500 ? 'warning' : 'good')
        setMetric('metric-errors', (data.errorRate || 0).toFixed(1), '%', v => parseFloat(v) > 5 ? 'danger' : parseFloat(v) > 1 ? 'warning' : 'good')
        setMetric('metric-memory', (data.memoryMB || 0).toFixed(0), 'MB', v => parseFloat(v) > 200 ? 'danger' : parseFloat(v) > 100 ? 'warning' : 'good')
        setMetric('metric-status', data.healthy ? '200' : data.statusCode || '???', '', v => v === '200' ? 'good' : 'danger')
    }

    function setMetric(id, value, unit, colorFn) {
        const el = document.getElementById(id)
        if (!el) return
        const valueEl = el.querySelector('.metric-value')
        if (valueEl) {
            valueEl.textContent = value
            valueEl.className = 'metric-value'
            if (colorFn) valueEl.classList.add(colorFn(value))
            const unitEl = el.querySelector('.metric-unit')
            if (unitEl) unitEl.textContent = unit
        }
    }

    // ─── System Badge ────────────────────────────
    function updateSystemBadge(status) {
        const badge = $('.status-badge')
        if (!badge) return

        badge.classList.remove('healthy', 'unhealthy', 'recovering')
        badge.classList.add(status)

        const label = badge.querySelector('.status-label')
        if (label) {
            label.textContent = status === 'healthy' ? 'All Systems Operational'
                : status === 'recovering' ? 'Incident Detected — Recovery In Progress'
                    : 'System Degraded'
        }

        systemStatus = status
    }

    // ─── Incident Report ─────────────────────────
    function showIncidentReport(data) {
        const card = $('.report-card')
        if (!card) return

        card.classList.add('visible')

        const content = card.querySelector('.report-content')
        if (!content) return

        const report = data.report || data
        content.innerHTML = `<span class="report-section-title">═══ INCIDENT REPORT ═══</span>

<span class="report-section-title">▸ Incident ID:</span>    ${data.incidentId || 'N/A'}
<span class="report-section-title">▸ Duration:</span>       ${formatDuration(report.durationMs || data.durationMs)}
<span class="report-section-title">▸ Actions Taken:</span>  ${report.actionsCount || 'N/A'}

<span class="report-section-title">▸ Root Cause:</span>
  ${report.rootCause || 'Analysis pending'}

<span class="report-section-title">▸ Recovery Status:</span> ✅ Resolved`
    }

    // ─── Chaos Controls ──────────────────────────
    function setupChaosControls() {
        $$('.chaos-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const type = btn.dataset.chaos
                if (!type) return

                btn.disabled = true
                try {
                    const response = await fetch(`${API_URL}/api/chaos/${type}`, { method: 'POST' })
                    const data = await response.json()
                    console.log(`[Chaos] ${type}:`, data)
                } catch (err) {
                    console.error(`[Chaos] ${type} failed:`, err)
                } finally {
                    setTimeout(() => { btn.disabled = false }, 2000)
                }
            })
        })
    }

    function flashChaosButton(type) {
        const btn = $(`.chaos-btn[data-chaos="${type}"]`)
        if (!btn) return
        btn.style.boxShadow = '0 0 20px var(--red-glow)'
        setTimeout(() => { btn.style.boxShadow = '' }, 1000)
    }

    // ─── Initial Data Fetch ──────────────────────
    async function fetchInitialData() {
        try {
            const statusRes = await fetch(`${API_URL}/api/status`)
            if (statusRes.ok) {
                const data = await statusRes.json()
                if (data.system) {
                    updateHealthPanel({
                        healthy: data.system.demoApp.healthy,
                        statusCode: data.system.demoApp.statusCode,
                        responseTimeMs: data.system.demoApp.responseTimeMs,
                        errorRate: data.metrics.errorRate,
                        memoryMB: data.metrics.memoryUsageMB,
                    })
                }
                if (data.orchestrator) {
                    updateSystemBadge(data.activeIncident ? 'recovering' : 'healthy')
                }
            }
        } catch (err) {
            console.log('[Init] Could not fetch initial status:', err.message)
        }
    }

    // ─── Init ────────────────────────────────────
    function init() {
        renderPipeline()
        setupChaosControls()
        fetchInitialData()
        connectWebSocket()

        // Periodic status refresh
        setInterval(async () => {
            try {
                const res = await fetch(`${API_URL}/api/status`)
                if (res.ok) {
                    const data = await res.json()
                    if (data.system && data.system.demoApp) {
                        updateHealthPanel({
                            healthy: data.system.demoApp.healthy,
                            statusCode: data.system.demoApp.statusCode,
                            responseTimeMs: data.system.demoApp.responseTimeMs,
                            errorRate: data.metrics?.errorRate || 0,
                            memoryMB: data.metrics?.memoryUsageMB || 0,
                        })
                    }
                }
            } catch { }
        }, 10000)
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init)
    } else {
        init()
    }
})()
