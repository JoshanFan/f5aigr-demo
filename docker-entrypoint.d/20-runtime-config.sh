#!/bin/sh
set -eu

template_path="/usr/share/nginx/html/runtime-config.js.template"
output_path="/usr/share/nginx/html/runtime-config.js"

if [ -f "${template_path}" ]; then
  envsubst '${DEMO_PROJECT_ID} ${DEMO_API_TOKEN}' < "${template_path}" > "${output_path}"
fi
