# syntax=docker/dockerfile:1
# Build for both architectures:
#   docker buildx build --platform linux/amd64,linux/arm64 --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
# For a build that others can reproduce bit for bit, use the command in docs/VERIFY.md (it adds
# SOURCE_DATE_EPOCH, rewrite-timestamp and no provenance attestation).
# The base image is pinned by digest (the multi-arch index of node:24-alpine) so that a rebuild of the
# same commit starts from the same bytes. Bump it on purpose; see docs/VERIFY.md.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS deps
WORKDIR /app
# The relay's only runtime dependency. Keep the version in step with package.json.
RUN npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --no-package-lock ws@8.22.0

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
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
