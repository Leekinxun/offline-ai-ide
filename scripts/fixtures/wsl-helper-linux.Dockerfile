FROM node:22-bookworm-slim

# The slim image does not include a system CA bundle. Use Node's public trust
# roots to bootstrap authenticated Debian package downloads.
RUN node -e "const fs=require('fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('tls').rootCertificates.join('\n'))"
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap procps \
    && rm -rf /var/lib/apt/lists/*
RUN ln -s /usr/local/bin/node /usr/bin/node
USER node
