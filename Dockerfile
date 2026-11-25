# Node host for Google Cloud Run (or any container platform): server/node.js serves the API and the built app.
# Postgres when DATABASE_URL is set; otherwise SQLite at SQLITE_PATH (lost when the container restarts).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 SQLITE_PATH=/tmp/opentrack.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "server/node.js"]
