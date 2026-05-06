FROM node:20-alpine

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js db.js auth.js api.js .

EXPOSE 3003
CMD ["node", "server.js"]
