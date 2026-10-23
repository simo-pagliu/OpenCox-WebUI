FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html config.js /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY vendor /usr/share/nginx/html/vendor

# config.js is rewritten at start-up from the OPENCOX_* environment variables,
# on top of the defaults kept here.
COPY config.js /opt/opencox/config.js
COPY docker/opencox-config.sh /docker-entrypoint.d/40-opencox-config.sh
RUN chmod +x /docker-entrypoint.d/40-opencox-config.sh

EXPOSE 80
