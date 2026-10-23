#!/bin/sh
# Writes the page's config.js at container start: the defaults from the
# repository's config.js, then every OPENCOX_* environment variable that is
# set (set but empty clears that setting). The nginx image's entrypoint runs
# this, like its own scripts in /docker-entrypoint.d/.
set -eu

# $1 as a JavaScript string literal, control characters (newlines too) as
# spaces.
js_string() {
    printf '"%s"' "$(printf '%s' "$1" | tr '\000-\037' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# "key: value," for config key $1, if environment variable $2 is set.
override() {
    if value=$(printenv "$2"); then
        printf '    %s: %s,\n' "$1" "$(js_string "$value")"
    fi
}

{
    cat /opt/opencox/config.js
    printf '\n// From the OPENCOX_* environment variables, at container start.\n'
    printf 'Object.assign(window.OPENCOX_CONFIG, {\n'
    override homeUrl OPENCOX_HOME_URL
    override footerText OPENCOX_FOOTER_TEXT
    override footerUrl OPENCOX_FOOTER_URL
    override repoUrl OPENCOX_REPO_URL
    printf '});\n'
} > /usr/share/nginx/html/config.js
