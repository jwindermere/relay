FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install --global @openai/codex@0.149.1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/build ./build
COPY --from=build /app/build-runtime ./build-runtime
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /home/node/.codex /var/lib/relay/agent-runs \
  && chown -R node:node /home/node/.codex /var/lib/relay
USER node
CMD ["npm", "run", "start:web"]
