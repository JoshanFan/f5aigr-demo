FROM nginx:alpine

# Install njs module and load it in main nginx.conf
RUN apk add --no-cache nginx-module-njs ca-certificates \
 && sed -i '1s|^|load_module modules/ngx_http_js_module.so;\n|' /etc/nginx/nginx.conf

# Remove default nginx page
RUN rm -rf /usr/share/nginx/html/*

# Copy njs orchestrator
COPY nginx/orchestrator.js /etc/nginx/njs/orchestrator.js

# Copy frontend static files
COPY index.html    /usr/share/nginx/html/
COPY styles.css    /usr/share/nginx/html/
COPY app.js        /usr/share/nginx/html/
COPY scan-utils.js /usr/share/nginx/html/

# Copy nginx config template
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
