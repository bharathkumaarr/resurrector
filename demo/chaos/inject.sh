#!/bin/bash
set -e

BASE_URL="${DEMO_APP_URL:-http://localhost:8080}"

case "$1" in
  crash)
    echo "Triggering crash..."
    curl -X POST "$BASE_URL/chaos/crash"
    ;;
  unhealthy)
    echo "Setting service unhealthy..."
    curl -X POST "$BASE_URL/chaos/unhealthy"
    ;;
  memory)
    echo "Triggering memory leak..."
    curl -X POST "$BASE_URL/chaos/memory-leak"
    ;;
  latency)
    MS="${2:-5000}"
    echo "Setting latency to ${MS}ms..."
    curl -X POST "$BASE_URL/chaos/latency/$MS"
    ;;
  reset)
    echo "Resetting chaos state..."
    curl -X POST "$BASE_URL/chaos/reset"
    ;;
  *)
    echo "Usage: $0 {crash|unhealthy|memory|latency [ms]|reset}"
    exit 1
    ;;
esac
