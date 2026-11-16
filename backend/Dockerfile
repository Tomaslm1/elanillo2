FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --ignore-scripts && DATABASE_URL=postgresql://build:build@localhost/build npx prisma generate
COPY server.js ./
COPY src ./src
ENV NODE_ENV=production FRONTEND_DIR=/frontend PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
