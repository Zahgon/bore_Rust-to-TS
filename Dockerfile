FROM node:22-alpine AS builder
WORKDIR /home/node/src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /home/node/src/dist ./dist
COPY --from=builder /home/node/src/node_modules ./node_modules
COPY --from=builder /home/node/src/package.json ./package.json
USER 1000:1000
ENTRYPOINT ["node", "dist/src/main.js"]
