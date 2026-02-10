#!/usr/bin/env python3
from flask import Flask, Response
import json
import subprocess
import logging

# 🔇 Silenciar access log de Flask/Werkzeug
logging.getLogger('werkzeug').setLevel(logging.ERROR)

app = Flask(__name__)
METRICS_SCRIPT = "/tools/metrics.sh"

@app.route("/metrics", methods=["GET"])
def get_metrics():
    try:
        # Ejecutar script y capturar stdout directamente
        result = subprocess.run(
            ["/bin/bash", METRICS_SCRIPT],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        # Verificar si se ejecutó correctamente
        if result.returncode != 0:
            return Response(
                json.dumps({"error": f"Script failed: {result.stderr}"}, sort_keys=False),
                mimetype="application/json",
                status=500
            )
        
        # Validar que stdout contiene JSON válido
        try:
            json.loads(result.stdout)  # Validar
        except json.JSONDecodeError:
            return Response(
                json.dumps({"error": "Invalid JSON output from script"}, sort_keys=False),
                mimetype="application/json",
                status=500
            )
        
        # Devolver stdout directamente (sin escribir a disco)
        return Response(result.stdout, mimetype="application/json")
            
    except subprocess.TimeoutExpired:
        return Response(
            json.dumps({"error": "Metrics script timeout"}, sort_keys=False),
            mimetype="application/json",
            status=500
        )
    except Exception as e:
        return Response(
            json.dumps({"error": f"Failed to get metrics: {str(e)}"}, sort_keys=False),
            mimetype="application/json",
            status=500
        )

# Ejecuta el servidor en 0.0.0.0 para que sea accesible desde el host
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)