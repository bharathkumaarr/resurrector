# Archestra Platform Integration Guide 🛡️

This guide explains how to leverage the **Archestra AI Platform** to power Resurrector. This is the setup you'll want to show for the hackathon.

## 1. Launch the Platform
Ensure all services are running:
```bash
docker compose up -d
```
Access the Archestra UI at: **http://localhost:3000**

---

## 2. Register Private MCP Servers
Archestra handles the lifecycle and security of your tools. Register the 6 servers we've built:

1. Go to **Private Registry** in the Archestra Sidebar.
2. Click **Add New MCP Server**.
3. Point to the local builds:
   - **Name**: `kubernetes-mcp`
   - **Command**: `node`
   - **Arguments**: `[/absolute/path/to]/mcp-servers/kubernetes/dist/index.js`
4. Repeat for: `logs`, `metrics`, `database`, `deployment`, and `config`.

> [!TIP]
> This demonstrates the **Private Registry** feature, keeping your infrastructure control logic local and secure.

---

## 3. Build the Agents
Use Archestra's **Agent Builder** to create the "Brain" of Resurrector.

1. **Create Agent**: Name it `Observability Agent`.
2. **System Prompt**: Copy from `agents/observability-agent.md`.
3. **Tools**: Select all tools from `metrics-mcp` and `logs-mcp`.
4. **Repeat** for all 7 agents using their respective prompts in `agents/`.

---

## 4. Configure A2A Orchestration
The magic of Archestra is **Agent-to-Agent (A2A)** collaboration.

1. In the **Orchestrator** view, link your agents:
   - `Observability` → triggers → `Analyzer`
   - `Analyzer` → triggers → `Self-Healer`
   - ...and so on.
2. This creates the autonomous pipeline visualized in the `resurrector` dashboard.

---

## 5. Enable Dual LLM Security
For the **Self-Healing** and **Disaster Recovery** agents:
1. In the Agent settings, toggle **Dual LLM Verification**.
2. This ensures that a secondary LLM verifies any destructive actions (like `restart_pod` or `restore_snapshot`) before execution.

---

## 6. The Hackathon Showcase
To demo the project effectively:
1. Open the **Archestra Chat UI**.
2. Start a "SRE Session".
3. Run the chaos script: `./demo/chaos/inject.sh unhealthy`.
4. Go back to Archestra and watch the **Observability Agent** detect the anomaly and start talking to the **Analyzer** via A2A.
5. Watch the **Self-Healing Agent** execute a fix verified by the **Dual LLM Security**.

---

**Resurrector + Archestra = Zero-Downtime Infrastructure.**
