FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node public ./public
COPY --chown=node:node worker ./worker
COPY --chown=node:node server ./server
COPY --chown=node:node scripts ./scripts
RUN node scripts/build-assets.mjs
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
