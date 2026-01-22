FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js template.html ./

ENV NODE_ENV=production
EXPOSE 10000

CMD ["npm", "start"]
