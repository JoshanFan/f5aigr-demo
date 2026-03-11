#!/bin/sh
set -eu

template_path="${RUNTIME_CONFIG_DIR:-/usr/share/nginx/html}/runtime-config.js.template"
output_path="${RUNTIME_CONFIG_DIR:-/usr/share/nginx/html}/runtime-config.js"

if [ -f "${template_path}" ]; then
  envsubst '${DEMO_PROJECT_ID} ${DEMO_API_TOKEN} ${API_BASE_URL}' < "${template_path}" > "${output_path}"
fi
