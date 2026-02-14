#!/bin/sh
PATCH=$(cat /tmp/k8s-patch.json)
for d in \
  mcp-config-mcp-ndavfz93cbmocogfksjqxiqupq2qcmhg \
  mcp-database-mcp-ndavfz93cbmocogfksjqxiqupq2qcmhg \
  mcp-deployment-mcp-ndavfz93cbmocogfksjqxiqupq2qcmhg \
  mcp-kubernetes-mcp-ndavfz93cbmocogfksjqxiqupq2qcmhg \
  mcp-logs-mcp-ndavfz93cbmocogfksjqxiqupq2qcmhg \
  mcp-metrics-mcp-ndavfz93cbmocogfksjqxiqupq2qcmhg
do
  echo "Patching $d..."
  kubectl patch deployment "$d" -n default --type=strategic -p "$PATCH"
  echo ""
done
echo "Done! Checking pod status..."
sleep 3
kubectl get pods -n default
