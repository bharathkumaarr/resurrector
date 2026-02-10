# Resurrector

Autonomous self-healing and disaster recovery platform built on Archestra AI.

## Architecture

Resurrector uses multi-agent orchestration to detect, diagnose, and recover from infrastructure failures automatically.

```
Observability Agent → Incident Analyzer → Self-Healing Agent
                                                ↓
                                     Recovery Decision Agent
                                         ↓           ↓
                              Disaster Recovery   (resolved)
                                         ↓
                                  Traffic Switch
                                         ↓
                                Incident Reporter
```

## MCP Servers

| Server | Tools |
|--------|-------|
| kubernetes-mcp | get_pods, restart_pod, scale_deployment, get_events |
| logs-mcp | get_logs, search_logs, get_error_logs |
| metrics-mcp | query_prometheus, get_resource_usage, get_alerts |
| database-mcp | create_snapshot, restore_snapshot, verify_snapshot |
| deployment-mcp | rollback_deployment, update_image, restart_deployment |
| config-mcp | get_configmap, update_configmap, validate_config |

## Quick Start

### 1. Start Archestra Platform

```bash
docker-compose up -d
```

### 2. Access Archestra UI

Open http://localhost:3000

### 3. Register MCP Servers

In Archestra MCP Registry:
1. Add each MCP server from `mcp-servers/`
2. Configure credentials if needed

### 4. Create Agents

In Archestra Agent Builder:
1. Create each agent using prompts from `agents/`
2. Assign appropriate MCP tools
3. Set up A2A connections between agents

### 5. Test with Chaos

```bash
chmod +x demo/chaos/inject.sh
./demo/chaos/inject.sh crash
```

## Project Structure

```
resurrector/
├── mcp-servers/
│   ├── kubernetes/    # K8s control
│   ├── logs/          # Log access
│   ├── metrics/       # Prometheus queries
│   ├── database/      # Backup/restore
│   ├── deployment/    # Deployment control
│   └── config/        # ConfigMap/Secret
├── agents/            # Agent system prompts
├── demo/
│   ├── app/           # Demo application
│   └── chaos/         # Failure injection
├── config/            # Prometheus config
└── docker-compose.yml
```

## Agents

1. **Observability Agent** - Monitors logs, metrics, detects anomalies
2. **Incident Analyzer** - Root cause analysis
3. **Self-Healing Agent** - Executes recovery actions
4. **Recovery Decision** - Escalation logic
5. **Disaster Recovery** - Full infrastructure restore
6. **Traffic Switch** - Routes traffic to recovered system
7. **Incident Reporter** - Generates RCA reports

## License

MIT
