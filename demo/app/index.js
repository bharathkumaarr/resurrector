import express from 'express'
import pg from 'pg'
import client from 'prom-client'

const app = express()
const port = process.env.PORT || 8080

const register = new client.Registry()
client.collectDefaultMetrics({ register })

const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5],
})
register.registerMetric(httpRequestDuration)

const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
})
register.registerMetric(httpRequestsTotal)

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
})

let healthy = true
let memoryLeak = []
let artificialLatency = 0

app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
        const duration = (Date.now() - start) / 1000
        httpRequestDuration.observe(
            { method: req.method, route: req.path, status: res.statusCode },
            duration
        )
        httpRequestsTotal.inc({ method: req.method, route: req.path, status: res.statusCode })
    })
    next()
})

app.get('/health', async (req, res) => {
    if (!healthy) {
        return res.status(503).json({ status: 'unhealthy' })
    }

    try {
        await pool.query('SELECT 1')
        res.json({ status: 'healthy', timestamp: new Date().toISOString() })
    } catch (err) {
        res.status(503).json({ status: 'unhealthy', error: err.message })
    }
})

app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType)
    res.end(await register.metrics())
})

app.get('/api/data', async (req, res) => {
    if (artificialLatency > 0) {
        await new Promise(resolve => setTimeout(resolve, artificialLatency))
    }

    try {
        const result = await pool.query('SELECT NOW() as time')
        res.json({ data: result.rows[0], memoryUsage: process.memoryUsage() })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.post('/chaos/crash', (req, res) => {
    res.json({ message: 'Crashing in 1 second' })
    setTimeout(() => process.exit(1), 1000)
})

app.post('/chaos/unhealthy', (req, res) => {
    healthy = false
    res.json({ message: 'Service marked unhealthy' })
})

app.post('/chaos/healthy', (req, res) => {
    healthy = true
    res.json({ message: 'Service marked healthy' })
})

app.post('/chaos/memory-leak', (req, res) => {
    const leakSize = 10 * 1024 * 1024
    for (let i = 0; i < 10; i++) {
        memoryLeak.push(Buffer.alloc(leakSize))
    }
    res.json({
        message: 'Memory leak triggered',
        leakedMB: memoryLeak.length * 10,
        memoryUsage: process.memoryUsage(),
    })
})

app.post('/chaos/latency/:ms', (req, res) => {
    artificialLatency = parseInt(req.params.ms, 10) || 0
    res.json({ message: `Latency set to ${artificialLatency}ms` })
})

app.post('/chaos/reset', (req, res) => {
    healthy = true
    memoryLeak = []
    artificialLatency = 0
    global.gc && global.gc()
    res.json({ message: 'Chaos state reset' })
})

app.listen(port, () => {
    console.log(`Demo app listening on port ${port}`)
})
