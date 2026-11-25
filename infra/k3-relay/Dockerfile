# syntax=docker/dockerfile:1
# Build for both architectures:
#   docker buildx build --platform linux/amd64,linux/arm64 --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
FROM node:24-alpine AS deps
WORKDIR /app
# The relay's only runtime dependency. Keep the version in step with package.json.
RUN npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --no-package-lock ws@8.22.0

FROM node:24-alpine
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT} \
    PORT=8080 \
    DB_PATH=/data/relay.sqlite \
    NODE_OPTIONS=--max-old-space-size=320
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]
