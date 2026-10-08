# Dùng image chính thức của Playwright — đã cài sẵn Chromium + mọi thư viện hệ thống cần thiết
# (image "thường" như node:20-slim không có, phải tự apt-get, dễ thiếu lib -> Chromium crash im lặng).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "backend/server.js"]
