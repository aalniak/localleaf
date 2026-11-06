# All-in-one image: Localleaf + full TeX Live in one container.
#   docker compose up -d        (see docker-compose.yml)
# Pin a TeX Live release with: --build-arg TEXLIVE_IMAGE=texlive/texlive:TL2025-historic
ARG TEXLIVE_IMAGE=texlive/texlive:latest

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ${TEXLIVE_IMAGE}
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# Fail the build early if the TeX Live base is too old for this Node binary.
RUN node --version && useradd --create-home --uid 10001 localleaf \
 && mkdir -p /data \
 && chown localleaf:localleaf /data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/web/dist ./web/dist

ENV NODE_ENV=production \
    PORT=4000 \
    LOCALLEAF_HOST=0.0.0.0 \
    LOCALLEAF_COMPILER=texlive \
    LOCALLEAF_DATA_DIR=/data \
    LOCALLEAF_WORK_DIR=/tmp/localleaf-work
USER localleaf
EXPOSE 4000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.js"]
