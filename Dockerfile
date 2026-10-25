# Production image (deploy/README.md). Built for linux/arm64 in CI.

# The build stage runs on the CI machine's own platform: compiled JS is the
# same on every CPU, so only the final stage needs arm64 (no slow emulated tsc).
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
USER node
EXPOSE 4000
# node directly, not `npm start`, so SIGTERM from `docker stop` reaches the app.
CMD ["node", "dist/server.js"]
