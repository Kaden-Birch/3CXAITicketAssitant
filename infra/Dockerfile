FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY db ./db
COPY docs ./docs
RUN npm ci && npm run build
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=build /app /app
RUN npm prune --omit=dev && mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["npm","start"]
